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

use hardware::HardwareService;
use mqtt::MqttManager;
use runtime::host::{self, BoardLink};
use runtime::services::{LlmRegistry, MqttPublisher};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Listener;
use tokio::sync::Mutex as TokioMutex;

/// Which callback shape a subscription drives. Stored alongside the live
/// subscription so `flow_update` can tell when a topic's *owner* changed (and
/// must be re-subscribed) versus left untouched — the broker holds one callback
/// per topic, so the owner is part of a subscription's identity.
///
/// Re-exported from core: the subscription winner-selection policy that consumes
/// this kind ([`microflow_core::runtime::reconcile_desired`]) is the single
/// source shared with the browser host via the wasm `reconcileSubscriptions()`
/// binding, so both hosts pick the same owner per topic.
pub use microflow_core::runtime::SubKind;

/// One active Figma/MQTT subscription. Identity is `(broker_id, topic)`; the
/// `component_id`/`kind` record which wiring currently owns the broker's single
/// per-topic callback, so `flow_update` can diff and only touch what changed.
#[derive(Debug, Clone)]
pub struct FigmaSubscription {
    pub broker_id: String,
    pub topic: String,
    pub component_id: String,
    pub kind: SubKind,
}

/// Shared application state
pub struct AppState {
    pub hardware_service: Arc<Mutex<HardwareService>>,
    /// `Send + Sync` sender to the runtime actor thread, which owns the
    /// single-threaded (`!Send`) `core::FlowRuntime` + the serial port. Replaces
    /// the old `Arc<TokioMutex<FlowRuntime>>`; commands post `ActorMsg`s here.
    pub actor: tokio::sync::mpsc::UnboundedSender<runtime::host::ActorMsg>,
    /// MQTT broker manager
    pub mqtt_manager: MqttManager,
    /// MQTT publish handle the cloud nodes hold (captured by the actor's cloud
    /// factory closures); also used directly by `flow_update` for status pings.
    pub mqtt_publisher: Arc<dyn MqttPublisher>,
    /// Live LLM provider registry. Shared with the actor's cloud factories so
    /// components resolve providers at dispatch time and pick up credential
    /// rotation. Filled by the `flow_update` and `llm_sync_providers` commands.
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

    // Flow-runtime tracing. microflow-core emits a `flow_tick` span + drain
    // traces as `tracing` events; this fmt subscriber renders them to stdout
    // (visible under `tauri dev`). Honors `RUST_LOG`, else quiet deps with flow
    // ticks at debug.
    let trace_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,microflow_core=debug"));
    // `set_global_default`, NOT `.init()`: `.init()` also installs a `log`→tracing
    // bridge (LogTracer) that claims the global `log` logger, which makes
    // `tauri-plugin-log` panic with "attempted to set a logger after the logging
    // system was already initialized". Setting only the tracing dispatcher keeps
    // the two independent — `tauri-plugin-log` owns `log::`, this owns `tracing::`.
    let _ = tracing::subscriber::set_global_default(
        tracing_subscriber::fmt().with_env_filter(trace_filter).finish(),
    );

    let hardware_service = Arc::new(Mutex::new(HardwareService::new()));

    let mqtt_manager = MqttManager::new();
    // `MqttManager` is `Clone` (its broker map lives behind `Arc<RwLock<..>>`),
    // so the cloned instance handed to the dyn-trait `Arc` shares the same
    // broker pool as the one held on `AppState`.
    let mqtt_publisher: Arc<dyn MqttPublisher> = Arc::new(mqtt_manager.clone());
    let llm_registry = Arc::new(LlmRegistry::new());

    // The runtime actor channel + its shared connected flag. The channel is
    // created here so the `Send + Sync` sender can live on `AppState` (and the
    // hardware `BoardLink`); the actor *thread* is spawned in `setup`, where the
    // `AppHandle` + Tokio runtime handle are available.
    let (actor_tx, actor_rx) = tokio::sync::mpsc::unbounded_channel::<host::ActorMsg>();
    let board_connected = Arc::new(AtomicBool::new(false));

    // Clones the actor thread captures (cloud factory services); the originals
    // move into `AppState`.
    let actor_publisher = Arc::clone(&mqtt_publisher);
    let actor_registry = Arc::clone(&llm_registry);
    let actor_tx_exit = actor_tx.clone();

    let app_state = AppState {
        hardware_service: Arc::clone(&hardware_service),
        actor: actor_tx.clone(),
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
        .setup(move |app| {
            // Registered in every build: the default targets (stdout + OS log
            // dir) are the only place flash/board failures can be diagnosed in
            // production (Windows: %LOCALAPPDATA%\tech.microflow\logs, macOS:
            // ~/Library/Logs/tech.microflow).
            let log_builder = tauri_plugin_log::Builder::default().level(log::LevelFilter::Info);
            let log_builder = if cfg!(debug_assertions) {
                // Forward `log::` records (hardware, MQTT, LLM, …) to the
                // webview via the `log://log` event so the in-app Microflow
                // devtools shows the whole backend's activity, not just flow
                // events. `.target` appends — stdout/log-dir stay intact.
                log_builder.target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Webview,
                ))
            } else {
                log_builder
            };
            app.handle().plugin(log_builder.build())?;

            // Tauri's own Tokio runtime handle — where the MQTT/LLM tasks live,
            // so the actor's cloud-node spawns + wakeup timers share it. Cheap,
            // non-blocking, and valid on whichever thread `setup` runs on.
            let rt_handle = tauri::async_runtime::handle().inner().clone();

            // Spawn the single runtime actor thread: it owns the !Send
            // core::FlowRuntime + the serial port, and applies each turn's
            // Effects (write bytes, emit "component-event", arm wakeup timers).
            host::run_actor(
                actor_rx,
                actor_tx.clone(),
                Arc::clone(&board_connected),
                app.handle().clone(),
                rt_handle,
                actor_publisher,
                actor_registry,
            );

            // Hardware monitoring drives the actor through a `BoardLink`: on
            // Firmata detection it sends `Connect{port, pins_json}`, on USB
            // removal / implicit reset `Disconnect`. The board-state observer
            // that used to mutate `AppState` in-process is now a no-op — the
            // actor owns connection + pending-flow state; the monitor still emits
            // `board-state` to the frontend itself.
            let board_link = BoardLink::new(actor_tx.clone(), Arc::clone(&board_connected));
            let observer: hardware::BoardStateObserver = Arc::new(|_state| {});
            hardware_service
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .start_monitoring(app.handle().clone(), board_link, observer);

            // Hotkeys: the webview emits "key_event" { key, pressed }; Rust owns
            // hotkey→component routing. Forward both key-down and key-up to the
            // actor, which dispatches to the registered Hotkey components.
            let actor_keys = actor_tx.clone();
            app.handle().listen("key_event", move |event| {
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    let key = data
                        .get("key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let pressed = data
                        .get("pressed")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    if key.is_empty() {
                        return;
                    }
                    log::info!("[HOTKEY] key_event: {key} pressed={pressed}");
                    let _ = actor_keys.send(host::ActorMsg::Key { accelerator: key, pressed });
                }
            });

            Ok(())
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
                log::info!("Application exiting — stopping runtime actor");
                // Stop the actor thread; it drops the serial port on the way out.
                let _ = actor_tx_exit.send(host::ActorMsg::Shutdown);
            }
        });
}
