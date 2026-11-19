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
//! └── flasher/         - Firmware flashing (runs microflow-core's bootloader drivers)
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
pub mod cli_llm;
mod error;
pub mod mcp;
mod flasher;
pub mod hardware;
pub mod mqtt;
pub mod runtime;

pub use error::*;

use hardware::HardwareService;
use mqtt::MqttManager;
use runtime::cloud_performer::CloudPerformer;
use runtime::host::{self, ActorLink};
use runtime::services::MqttBrokers;
use std::sync::{Arc, Mutex};
use tauri::Listener;

/// Shared application state.
///
/// The flow's MQTT subscriptions are not here: the [`CloudPerformer`] owns
/// them, and only the runtime actor holds it.
pub struct AppState {
    pub hardware_service: Arc<Mutex<HardwareService>>,
    /// `Send + Sync` sender to the runtime actor thread, which owns the
    /// single-threaded (`!Send`) `core::FlowRuntime` + the serial port. Replaces
    /// the old `Arc<TokioMutex<FlowRuntime>>`; commands post `ActorMsg`s here.
    pub actor: tokio::sync::mpsc::UnboundedSender<runtime::host::ActorMsg>,
    /// MQTT broker pool: the connections the broker settings and
    /// `flow_update` manage, and the pool the `CloudPerformer` publishes and
    /// subscribes through.
    pub mqtt_manager: MqttManager,
    /// The flow updates the webview sends: what the `flow_update` command
    /// does, and the order it is done in.
    pub flow_updates: runtime::commands::FlowUpdates,
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
    let cloud_brokers: Arc<dyn MqttBrokers> = Arc::new(mqtt_manager.clone());
    let status_brokers = mqtt_manager.clone();
    let console_brokers = mqtt_manager.clone();
    let exit_brokers = mqtt_manager.clone();

    // The runtime actor channel, plus the channel the actor reports a failed
    // board session on (to the hardware board link, which owns connection
    // state). Created here so the `Send + Sync` sender can live on `AppState`
    // (and the hardware `ActorLink`); the actor *thread* is spawned in `setup`,
    // where the `AppHandle` + Tokio runtime handle are available.
    let (actor_tx, actor_rx) = tokio::sync::mpsc::unbounded_channel::<host::ActorMsg>();
    let (session_ended_tx, session_ended_rx) = std::sync::mpsc::channel::<hardware::SessionId>();

    let actor_tx_exit = actor_tx.clone();
    // Filled in `setup` once the actor thread runs; the exit handler waits on
    // it so the board session drops (writing the safe state) before exit.
    let actor_stopped: Arc<Mutex<Option<host::ActorStopped>>> = Arc::new(Mutex::new(None));
    let actor_stopped_exit = Arc::clone(&actor_stopped);

    let app_state = AppState {
        hardware_service: Arc::clone(&hardware_service),
        actor: actor_tx.clone(),
        flow_updates: runtime::commands::FlowUpdates::new(actor_tx.clone(), mqtt_manager.clone()),
        mqtt_manager,
    };

    let mut builder = tauri::Builder::default();

    // Single-instance MUST be the first plugin registered. With the `deep-link`
    // feature it forwards `microflow://` URLs to the already-running instance on
    // Windows/Linux; we also focus the existing window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .setup(move |app| {
            // Register the microflow:// scheme at runtime so deep links work in
            // dev builds on Windows/Linux (macOS uses the bundled Info.plist).
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

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

            // Every change of a broker's status goes to the webview, whatever
            // caused it: the settings pages do not ask.
            rt_handle.spawn(mqtt::commands::report_broker_statuses(status_brokers, app.handle().clone()));

            // The cloud half of the runtime host: publishes what the flow's
            // cloud nodes record and owns its MQTT subscriptions. The actor is
            // its one holder; it needs the `AppHandle` for the `mqtt-message`
            // event, so it is built here.
            let cloud = Arc::new(CloudPerformer::new(
                cloud_brokers,
                actor_tx.clone(),
                app.handle().clone(),
                rt_handle.clone(),
            ));

            // Spawn the single runtime actor thread: it owns the !Send
            // core::FlowRuntime + the serial port, and applies each turn's
            // Effects (write bytes, emit "component-event", arm wakeup timers).
            let stopped = host::run_actor(
                actor_rx,
                actor_tx.clone(),
                session_ended_tx,
                app.handle().clone(),
                rt_handle,
                cloud,
            );
            *actor_stopped.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(stopped);

            // Hardware monitoring owns the board connection (the board link)
            // and drives the actor through an `ActorLink`: on Firmata detection
            // it sends `Connect{port, pins_json, session}`, on the board's own
            // port leaving / a lost session `Disconnect`. The board-state
            // observer that used to mutate `AppState` in-process is a no-op —
            // the actor owns pending-flow state; the monitor emits
            // `board-state` to the frontend itself.
            let observer: hardware::BoardStateObserver = Arc::new(|_state| {});
            hardware_service
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .start_monitoring(
                    app.handle().clone(),
                    ActorLink::new(actor_tx.clone()),
                    session_ended_rx,
                    observer,
                );

            // Publish the flow tools to agent CLIs over MCP. A failure here
            // costs Ask AI its CLI providers and nothing else, so it is logged
            // rather than propagated — the app still runs a board.
            if let Err(error) = mcp::listen(app.handle().clone()) {
                log::warn!("[mcp] not listening: {error}");
            }

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
        // A document starts loading in the webview — the first one, or a
        // reload: the page before it is gone, and with it the Connection
        // Console's list of what it subscribed to. Nothing on that page ran
        // to unsubscribe, so the pool is told here. (Moving between the app's
        // routes loads no document, and does not come by here.)
        .on_page_load(move |webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                let pool = console_brokers.clone();
                tauri::async_runtime::spawn(async move { pool.forget_console().await });
                // The page's agent CLI runs and its flow tool session go with it.
                cli_llm::page_gone(tauri::Manager::app_handle(webview));
            }
        })
        .manage(app_state)
        .manage(mcp::McpState::default())
        .manage(cli_llm::AgentCliRuns::default())
        .invoke_handler(tauri::generate_handler![
            hardware::get_available_serial_ports,
            hardware::confirm_board_flash,
            hardware::decline_board_flash,
            flasher::commands::flash_firmware,
            flasher::commands::flash_standard_firmata,
            flasher::commands::auto_flash_firmata,
            flasher::commands::get_supported_boards,
            runtime::commands::flow_update,
            runtime::commands::component_call,
            runtime::commands::llm_result,
            runtime::commands::runtime_restart,
            runtime::commands::runtime_status,
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
            cli_llm::llm_cli_probe,
            cli_llm::llm_cli_generate,
            cli_llm::llm_cli_stop,
            cli_llm::llm_cli_models,
            mcp::session::mcp_session_start,
            mcp::session::mcp_session_end,
            mcp::session::mcp_tool_result,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                log::info!("Application exiting — stopping runtime actor");
                // Stop the actor thread and wait (bounded) for it: dropping its
                // board session writes the safe state, and the process ends as
                // soon as this handler returns.
                let _ = actor_tx_exit.send(host::ActorMsg::Shutdown);
                let stopped = actor_stopped_exit.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
                if let Some(stopped) = stopped {
                    if !stopped.wait(host::SHUTDOWN_GRACE) {
                        log::warn!("[actor] did not stop within {:?}; exiting anyway", host::SHUTDOWN_GRACE);
                    }
                }
                // After the board is safe: an agent CLI must not outlive the
                // app that started it.
                cli_llm::quit(app_handle);
                // Every broker session ends on purpose, saying its last words:
                // the design-tool plugins hear that Studio left. Bounded, so a
                // broker that does not take them does not hold up the quit; its
                // link closes with the process, and the broker publishes the
                // session's will instead.
                let closing = exit_brokers.clone();
                let closed = tauri::async_runtime::block_on(async move {
                    tokio::time::timeout(mqtt::manager::QUIT_GRACE, closing.disconnect_all()).await
                });
                if closed.is_err() {
                    log::warn!("[MQTT] brokers not closed within {:?}; exiting anyway", mqtt::manager::QUIT_GRACE);
                }
            }
        });
}
