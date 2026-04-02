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

mod error;
mod flasher;
pub mod hardware;
pub mod llm;
pub mod mqtt;
pub mod runtime;

pub use error::*;

use hardware::HardwareService;
use llm::LlmManager;
use mqtt::MqttManager;
use runtime::{FlowRuntime, FlowUpdate};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{Emitter, Listener};
use tokio::sync::mpsc;
use tokio::sync::Mutex as TokioMutex;

/// MQTT publish request from flow components
#[derive(Debug, Clone)]
pub struct MqttPublishRequest {
    pub component_id: String,
    pub broker_id: String,
    pub topic: String,
    pub payload: String,
    pub retain: bool,
}

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
    /// Pending flow update to apply when board connects
    pub pending_flow: Arc<RwLock<Option<FlowUpdate>>>,
    /// Whether a Firmata board is connected
    pub board_connected: Arc<RwLock<bool>>,
    /// MQTT broker manager
    pub mqtt_manager: MqttManager,
    /// Channel for MQTT publish requests from flow components
    pub mqtt_publish_tx: mpsc::UnboundedSender<MqttPublishRequest>,
    /// LLM provider manager
    pub llm_manager: LlmManager,
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
    
    // Create channel for MQTT publish requests
    let (mqtt_publish_tx, mqtt_publish_rx) = mpsc::unbounded_channel::<MqttPublishRequest>();

    let mqtt_manager = MqttManager::new();
    let mqtt_manager_for_publish = mqtt_manager.clone();
    let llm_manager = LlmManager::new();

    let app_state = AppState {
        hardware_service: Arc::clone(&hardware_service),
        flow_runtime: Arc::clone(&flow_runtime),
        pending_flow: Arc::clone(&pending_flow),
        board_connected: Arc::clone(&board_connected),
        mqtt_manager,
        mqtt_publish_tx: mqtt_publish_tx.clone(),
        llm_manager,
        figma_subscriptions: Arc::new(TokioMutex::new(Vec::new())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
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

                // Start hardware monitoring with shared board handle
                let app_handle = app.handle().clone();
                // Use blocking_lock() for sync context during setup
                let board_handle = flow_runtime.blocking_lock().board_handle();
                hardware_service
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .start_monitoring(app_handle.clone(), board_handle);

                // Take the event receiver before spawning threads
                // Use blocking_lock() for sync context during setup
                let event_rx = flow_runtime.blocking_lock().take_event_receiver();

                // Set up event forwarding from flow runtime
                let app_handle_events = app_handle.clone();
                let flow_runtime_events = Arc::clone(&flow_runtime);
                let mqtt_publish_tx_events = mqtt_publish_tx.clone();
                std::thread::spawn(move || {
                    log::info!("Event forwarding thread started");
                    if let Some(mut rx) = event_rx {
                        log::info!("Event receiver obtained, waiting for events...");
                        while let Some(event) = rx.blocking_recv() {
                            log::trace!("Event: {} ({}) -> {:?}", 
                                event.source, event.source_handle, event.value);
                            
                            // Handle MQTT publish events specially
                            // These are emitted by MQTT publish nodes when they receive input
                            if event.source_handle.as_ref() == "_mqtt_publish" {
                                log::debug!("[MQTT] Publish event from component {}", event.source);
                                
                                // Parse the JSON publish info from the event value
                                if let runtime::ComponentValue::String(json_str) = &event.value {
                                    if let Ok(publish_info) = serde_json::from_str::<serde_json::Value>(json_str) {
                                        let broker_id = publish_info.get("brokerId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let topic = publish_info.get("topic").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let payload = publish_info.get("payload").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let retain = publish_info.get("retain").and_then(serde_json::Value::as_bool).unwrap_or(false);
                                        
                                        log::info!("[MQTT] Publishing to broker={broker_id}, topic={topic}, payload={payload}, retain={retain}");
                                        
                                        if !broker_id.is_empty() && !topic.is_empty() {
                                            let _ = mqtt_publish_tx_events.send(MqttPublishRequest {
                                                component_id: event.source.to_string(),
                                                broker_id,
                                                topic,
                                                payload,
                                                retain,
                                            });
                                        } else {
                                            log::warn!("[MQTT] Publish request missing broker_id or topic");
                                        }
                                    } else {
                                        log::error!("[MQTT] Failed to parse publish info JSON");
                                    }
                                }
                                continue;
                            }
                            
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

                // Spawn MQTT publish handler thread
                let mqtt_manager_publish = mqtt_manager_for_publish;
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Runtime::new().unwrap();
                    rt.block_on(async move {
                        let mut rx = mqtt_publish_rx;
                        log::info!("[MQTT] Publish handler thread started");
                        while let Some(request) = rx.recv().await {
                            log::info!("[MQTT] Processing publish request for component {}", request.component_id);
                            
                            // For now, we need the broker_id and topic from the request
                            // In a full implementation, we'd look these up from the component
                            if !request.broker_id.is_empty() && !request.topic.is_empty() {
                                if let Err(e) = mqtt_manager_publish.publish(
                                    &request.broker_id,
                                    &request.topic,
                                    request.payload.as_bytes(),
                                    request.retain,
                                ).await {
                                    log::error!("[MQTT] Failed to publish: {e}");
                                }
                            } else {
                                log::warn!("[MQTT] Publish request missing broker_id or topic");
                            }
                        }
                    });
                });

                // Listen for board-state events from hardware monitor
                let flow_runtime_board = Arc::clone(&flow_runtime);
                let pending_flow_board = Arc::clone(&pending_flow_setup);
                let board_connected_listener = Arc::clone(&board_connected_setup);
                app_handle.listen("board-state", move |event| {
                    // Parse the board state to check if it's actually connected
                    let payload = event.payload();
                    if let Ok(state) = serde_json::from_str::<serde_json::Value>(payload) {
                        let state_type = state.get("state").and_then(|s| s.as_str());
                        
                        match state_type {
                            Some("connected") => {
                                log::info!("Board connected with Firmata (shared connection)!");
                                *board_connected_listener.write().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
                                
                                // Apply pending flow if any, which will also install the callback
                                if let Some(flow) = pending_flow_board.write().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
                                    log::info!("Applying pending flow: {} nodes, {} edges", 
                                        flow.nodes.len(), flow.edges.len());
                                    // Use blocking_lock() for async mutex in sync callback context
                                    let mut runtime = flow_runtime_board.blocking_lock();
                                    if let Err(e) = runtime.update_flow(flow) {
                                        log::error!("Failed to apply pending flow: {e}");
                                    } else {
                                        // Initialize hardware (enables analog/digital reporting)
                                        if let Err(e) = runtime.initialize_hardware() {
                                            log::warn!("Failed to initialize hardware after pending flow: {e}");
                                        }
                                        // Install pin change callback after flow update
                                        let event_tx = runtime.event_sender();
                                        runtime.install_pin_change_callback(event_tx);
                                    }
                                } else {
                                    // No pending flow — board reconnected while a flow is
                                    // already active.  Reinitialize all hardware components so
                                    // that pin modes, analog reporting, etc. are reconfigured
                                    // on the fresh Arduino.  Without this, outputs like LEDs
                                    // and inputs like buttons silently stop working after
                                    // unplug/replug.
                                    let mut runtime = flow_runtime_board.blocking_lock();
                                    if let Err(e) = runtime.initialize_hardware() {
                                        log::warn!("Failed to reinitialize hardware on reconnect: {e}");
                                    }
                                    let event_tx = runtime.event_sender();
                                    runtime.install_pin_change_callback(event_tx);
                                }
                            }
                            Some("disconnected") => {
                                log::info!("Board disconnected");
                                *board_connected_listener.write().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
                                // Board handle is already disconnected by hardware monitor
                            }
                            Some(other) => {
                                log::debug!("Board state: {other}");
                            }
                            None => {}
                        }
                    }
                });

                // Remove the separate board-disconnected listener since we handle it above

                // Listen for key events from the webview (fire-and-forget, no IPC round-trip).
                // The frontend emits "key_event" with { key, pressed } — Rust owns all
                // hotkey→component routing and flow graph processing.
                let flow_runtime_keys = Arc::clone(&flow_runtime);
                app_handle.listen("key_event", move |event| {
                    let payload = event.payload();
                    if let Ok(data) = serde_json::from_str::<serde_json::Value>(payload) {
                        let key = data.get("key").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                        let pressed = data.get("pressed").and_then(|v| v.as_bool()).unwrap_or(false);

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
                                match map.get(&key) {
                                    Some(ids) => ids.clone(),
                                    None => {
                                        log::warn!("[HOTKEY] No listeners found for key={key}");
                                        return;
                                    }
                                }
                            };

                            log::info!("[HOTKEY] Routing key={key} to {} component(s)", component_ids.len());
                            let value = runtime::ComponentValue::Bool(pressed);
                            for component_id in &component_ids {
                                if let Err(e) = runtime.call_component(component_id, "key_event", value.clone()) {
                                    log::warn!("Failed to route key event to {}: {}", component_id, e);
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
                let mut runtime = runtime_shutdown.blocking_lock();

                // 2. Reset Firmata reporting and drive output pins low
                let board = runtime.board_handle();
                if board.is_connected() {
                    log::info!("Resetting board to safe state");
                    let _ = board.send_command(runtime::BoardCommand::ResetAllReporting);
                }

                // 3. Disconnect the board cleanly (stops reader thread)
                runtime.board_manager_mut().disconnect();

                // 4. Disconnect MQTT brokers
                // MqttManager::disconnect_all is async, but we're in a sync context.
                // The manager will be dropped anyway, but we try to send DISCONNECT packets.
                log::info!("Shutdown cleanup complete");
            }
        });
}
