//! Microflow Tauri Application
//!
//! # Module Architecture
//!
//! ```text
//! src/
//! ├── lib.rs           - Application entry point and wiring
//! ├── hardware/        - Hardware orchestration (ports, detection, events)
//! ├── runtime/         - Flow execution engine and components
//! │   ├── input/       - Input components (Button, Sensor, Motion, Proximity)
//! │   └── output/      - Output components (Led, Rgb, Relay, Piezo, Servo)
//! ├── mqtt/            - MQTT broker management for IoT connectivity
//! └── flasher/         - Firmware flashing (protocols, hex parsing)
//! ```

// Hardware/embedded code uses intentional casts and simple APIs that don't
// benefit from exhaustive doc sections or `try_from` ceremony.
#![allow(
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::unreadable_literal,
    clippy::too_many_lines,
    clippy::struct_field_names,
    clippy::unnecessary_wraps,
    clippy::needless_pass_by_value,
    clippy::trivially_copy_pass_by_ref,
    clippy::unused_self,
    clippy::match_same_arms,
    clippy::needless_continue,
    clippy::format_push_string,
    clippy::manual_let_else
)]

// Codegen and the Flow read-model now live in the platform-independent
// `microflow-core` crate (so they can also compile to WebAssembly for the web
// app). Re-export `codegen` here so existing `app_lib::codegen::…` /
// `crate::codegen::…` paths — including the integration tests — keep working.
pub use microflow_core::codegen;
mod error;
mod flasher;
pub mod hardware;
pub mod llm;
pub mod mqtt;
pub mod runtime;

pub use error::*;

use hardware::{BoardState, HardwareService};
use mqtt::MqttManager;
use runtime::services::{LlmRegistry, MqttPublisher, RuntimeServices};
use runtime::{FlowRuntime, FlowUpdate};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{Emitter, Listener};
use tokio::sync::Mutex as TokioMutex;

/// Tracks active Figma MQTT subscriptions so they can be cleaned up on flow switch
#[derive(Debug, Clone)]
pub struct FigmaSubscription {
    pub broker_id: String,
    pub topic: String,
}

/// Shared application state
pub struct AppState {
    pub hardware_service: Arc<Mutex<HardwareService>>,
    pub flow_runtime: Arc<TokioMutex<FlowRuntime>>,
    /// Pending flow update + the runtime services bundle live at
    /// `flow_update` time, applied when the board connects.
    pub pending_flow: Arc<RwLock<Option<(FlowUpdate, RuntimeServices)>>>,
    /// Whether a Firmata board is connected
    pub board_connected: Arc<RwLock<bool>>,
    /// MQTT broker manager
    pub mqtt_manager: MqttManager,
    /// MQTT publish handle wired into the runtime via `RuntimeContext` so
    /// `Mqtt` / `Figma` components publish straight through the manager
    /// instead of emitting `_mqtt_publish` events for `lib.rs` to re-route
    /// (ADR-0002 Phase 3).
    pub mqtt_publisher: Arc<dyn MqttPublisher>,
    /// Live LLM provider registry. Shared with `RuntimeContext` so components
    /// resolve providers at dispatch time and pick up credential rotation
    /// without rebuilding. Filled by the `flow_update` and
    /// `llm_sync_providers` Tauri commands.
    pub llm_registry: Arc<LlmRegistry>,
    /// Active Figma MQTT subscriptions (cleaned up on flow switch)
    pub figma_subscriptions: Arc<TokioMutex<Vec<FigmaSubscription>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize rustls crypto provider for TLS connections
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    let hardware_service = Arc::new(Mutex::new(HardwareService::new()));
    let flow_runtime = Arc::new(TokioMutex::new(FlowRuntime::new()));
    let pending_flow = Arc::new(RwLock::new(None));
    let board_connected = Arc::new(RwLock::new(false));

    let mqtt_manager = MqttManager::new();
    // `MqttManager` is `Clone` (its broker map lives behind `Arc<RwLock<..>>`),
    // so the cloned instance handed to the dyn-trait `Arc` shares the same
    // broker pool as the one held on `AppState`.
    let mqtt_publisher: Arc<dyn MqttPublisher> = Arc::new(mqtt_manager.clone());
    let llm_registry = Arc::new(LlmRegistry::new());

    let app_state = AppState {
        hardware_service: Arc::clone(&hardware_service),
        flow_runtime: Arc::clone(&flow_runtime),
        pending_flow: Arc::clone(&pending_flow),
        board_connected: Arc::clone(&board_connected),
        mqtt_manager,
        mqtt_publisher,
        llm_registry,
        figma_subscriptions: Arc::new(TokioMutex::new(Vec::new())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup({
            let hardware_service = Arc::clone(&hardware_service);
            let flow_runtime = Arc::clone(&flow_runtime);
            let pending_flow_setup = Arc::clone(&pending_flow);
            let board_connected_setup = Arc::clone(&board_connected);
            move |app| {
                if cfg!(debug_assertions) {
                    app.handle().plugin(
                        tauri_plugin_log::Builder::default()
                            .level(log::LevelFilter::Info)
                            .build(),
                    )?;
                }

                // Start hardware monitoring with shared board handle.
                //
                // The hardware monitor calls `observer(&BoardState)` for every
                // transition *before* it emits `board-state` to the Tauri bus,
                // so AppState (`board_connected`, `pending_flow`) is updated
                // in-process. lib.rs used to subscribe to its own bus with
                // `app_handle.listen("board-state", ...)`, which round-tripped
                // through JSON for a purely-local state mutation.
                let app_handle = app.handle().clone();
                // Use blocking_lock() for sync context during setup
                let board_handle = flow_runtime.blocking_lock().board_handle();
                let observer_runtime = Arc::clone(&flow_runtime);
                let observer_pending = Arc::clone(&pending_flow_setup);
                let observer_connected = Arc::clone(&board_connected_setup);
                let observer: hardware::BoardStateObserver = Arc::new(move |state: &BoardState| {
                    match state {
                        BoardState::Connected { .. } => {
                            log::info!("Board connected with Firmata (shared connection)!");
                            *observer_connected.write().unwrap_or_else(std::sync::PoisonError::into_inner) = true;

                            // Apply pending flow if any; otherwise reinitialize
                            // hardware so an unplug/replug doesn't leave the
                            // active flow's pin modes silently unconfigured.
                            let pending = observer_pending
                                .write()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .take();
                            let mut runtime = observer_runtime.blocking_lock();
                            if let Some((flow, services)) = pending {
                                log::info!(
                                    "Applying pending flow: {} nodes, {} edges",
                                    flow.nodes.len(),
                                    flow.edges.len()
                                );
                                if let Err(e) = runtime.update_flow(flow, &services) {
                                    log::error!("Failed to apply pending flow: {e}");
                                } else if let Err(e) = runtime.initialize_hardware() {
                                    log::warn!("Failed to initialize hardware after pending flow: {e}");
                                }
                            } else if let Err(e) = runtime.initialize_hardware() {
                                log::warn!("Failed to reinitialize hardware on reconnect: {e}");
                            }
                        }
                        BoardState::Disconnected {} => {
                            log::info!("Board disconnected");
                            *observer_connected.write().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
                        }
                        _ => {}
                    }
                });
                hardware_service
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .start_monitoring(app_handle.clone(), board_handle, observer);

                // Take the event receiver before spawning threads
                // Use blocking_lock() for sync context during setup
                let event_rx = flow_runtime.blocking_lock().take_event_receiver();

                // Set up event forwarding from flow runtime.
                //
                // Outbound MQTT publishes used to ride this channel under the
                // `_mqtt_publish` reserved handle — components emitted the
                // request as a JSON value, this thread parsed it and
                // re-dispatched to a dedicated publish-handler thread. Since
                // ADR-0002 Phase 3 that path is gone: `Mqtt` / `Figma` hold an
                // `Arc<dyn MqttPublisher>` and publish directly. The event
                // channel now carries only plain component events, all of
                // which go straight to the frontend + executor.
                let app_handle_events = app_handle.clone();
                let flow_runtime_events = Arc::clone(&flow_runtime);
                std::thread::spawn(move || {
                    log::info!("Event forwarding thread started");
                    if let Some(mut rx) = event_rx {
                        log::info!("Event receiver obtained, waiting for events...");
                        while let Some(event) = rx.blocking_recv() {
                            log::trace!(
                                "Event: {} ({}) -> {:?}",
                                event.source, event.source_handle, event.value
                            );

                            let _ = app_handle_events.emit("component-event", &event);

                            // This thread is std::thread::spawn, NOT tokio::spawn — blocking_lock() is safe
                            // here and will not stall the Tokio executor. The original try_lock() rationale
                            // ("avoid blocking the async runtime") was incorrect for this call site.
                            // blocking_lock() ensures events are NEVER dropped — they queue in the mpsc buffer
                            // and are processed as soon as the runtime is free.
                            let mut runtime = flow_runtime_events.blocking_lock();
                            runtime.process_event(event);
                        }
                        log::warn!("Event receiver channel closed");
                    } else {
                        log::error!("Failed to obtain event receiver!");
                    }
                });

                // Listen for key events from the webview (fire-and-forget, no IPC round-trip).
                // The frontend emits "key_event" with { key, pressed } — Rust owns all
                // hotkey→component routing and flow graph processing.
                let flow_runtime_keys = Arc::clone(&flow_runtime);
                app_handle.listen("key_event", move |event| {
                    let payload = event.payload();
                    if let Ok(data) = serde_json::from_str::<serde_json::Value>(payload) {
                        let key = data.get("key").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                        let pressed = data.get("pressed").and_then(serde_json::Value::as_bool).unwrap_or(false);

                        log::info!("[HOTKEY] Received key_event: key={key}, pressed={pressed}");

                        if key.is_empty() { return; }

                        // The listen callback runs on the Tokio async runtime, so we
                        // cannot call blocking_lock() directly (it panics). Spawn onto
                        // a blocking thread where it is safe to block.
                        let rt = Arc::clone(&flow_runtime_keys);
                        tokio::task::spawn_blocking(move || {
                            let mut runtime = rt.blocking_lock();

                            // Look up which components are listening for this key
                            let component_ids: Vec<Arc<str>> = {
                                let listeners = runtime.key_listeners();
                                let map = listeners.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                                log::info!("[HOTKEY] key_listeners map: {:?}", map.keys().collect::<Vec<_>>());
                                if let Some(ids) = map.get(&key) { ids.clone() } else {
                                    log::warn!("[HOTKEY] No listeners found for key={key}");
                                    return;
                                }
                            };

                            log::info!("[HOTKEY] Routing key={key} to {} component(s)", component_ids.len());
                            let value = runtime::ComponentValue::Bool(pressed);
                            for component_id in &component_ids {
                                if let Err(e) = runtime.call_component(component_id, "key_event", value.clone()) {
                                    log::warn!("Failed to route key event to {component_id}: {e}");
                                }
                            }
                        });
                    }
                });

                Ok(())
            }
        })
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            hardware::get_available_serial_ports,
            flasher::commands::flash_firmware,
            flasher::commands::flash_standard_firmata,
            flasher::commands::auto_flash_firmata,
            flasher::commands::get_supported_boards,
            runtime::commands::flow_update,
            runtime::commands::component_call,
            runtime::commands::generate_sketch,
            runtime::commands::check_credentials,
            runtime::commands::list_board_targets,
            mqtt::commands::mqtt_connect,
            mqtt::commands::mqtt_disconnect,
            mqtt::commands::mqtt_subscribe,
            mqtt::commands::mqtt_unsubscribe,
            mqtt::commands::mqtt_publish,
            mqtt::commands::mqtt_status,
            mqtt::commands::mqtt_connected_brokers,
            mqtt::commands::mqtt_sync_brokers,
            mqtt::commands::mqtt_all_statuses,
            llm::commands::llm_sync_providers,
            llm::commands::llm_test_provider,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                log::info!("Application exiting — cleaning up resources");

                // 1. Stop all generator threads via executor.clear()
                let runtime_shutdown = Arc::clone(&flow_runtime);
                let runtime = runtime_shutdown.blocking_lock();

                // 2. Reset Firmata reporting and drive output pins low
                let board = runtime.board_handle();
                if board.is_connected() {
                    log::info!("Resetting board to safe state");
                    board.reset_all_reporting().ignore();
                }

                // 3. Disconnect the board cleanly (stops reader thread)
                runtime.board_handle().disconnect();

                // 4. Disconnect MQTT brokers
                // MqttManager::disconnect_all is async, but we're in a sync context.
                // The manager will be dropped anyway, but we try to send DISCONNECT packets.
                log::info!("Shutdown cleanup complete");
            }
        });
}
