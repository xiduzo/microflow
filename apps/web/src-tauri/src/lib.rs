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
//! └── flasher/         - Firmware flashing (protocols, hex parsing)
//! ```

mod flasher;
mod hardware;
mod runtime;

use hardware::HardwareService;
use runtime::{FlowRuntime, FlowUpdate};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{Emitter, Listener};

/// Shared application state
pub struct AppState {
    pub hardware_service: Arc<Mutex<HardwareService>>,
    pub flow_runtime: Arc<Mutex<FlowRuntime>>,
    /// Pending flow update to apply when board connects
    pub pending_flow: Arc<RwLock<Option<FlowUpdate>>>,
    /// Whether a Firmata board is connected
    pub board_connected: Arc<RwLock<bool>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hardware_service = Arc::new(Mutex::new(HardwareService::new()));
    let flow_runtime = Arc::new(Mutex::new(FlowRuntime::new()));
    let pending_flow = Arc::new(RwLock::new(None));
    let board_connected = Arc::new(RwLock::new(false));

    let app_state = AppState {
        hardware_service: Arc::clone(&hardware_service),
        flow_runtime: Arc::clone(&flow_runtime),
        pending_flow: Arc::clone(&pending_flow),
        board_connected: Arc::clone(&board_connected),
    };

    tauri::Builder::default()
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
                let board_handle = flow_runtime.lock().unwrap().board_handle();
                hardware_service
                    .lock()
                    .unwrap()
                    .start_monitoring(app_handle.clone(), board_handle);

                // Take the event receiver before spawning threads
                let event_rx = flow_runtime.lock().unwrap().take_event_receiver();

                // Set up event forwarding from flow runtime
                let app_handle_events = app_handle.clone();
                let flow_runtime_events = Arc::clone(&flow_runtime);
                std::thread::spawn(move || {
                    log::info!("Event forwarding thread started");
                    if let Some(mut rx) = event_rx {
                        log::info!("Event receiver obtained, waiting for events...");
                        while let Some(event) = rx.blocking_recv() {
                            log::info!("Received event: {} ({}) -> {:?}", 
                                event.source, event.source_handle, event.value);
                            let _ = app_handle_events.emit("component-event", &event);
                            if let Ok(mut runtime) = flow_runtime_events.lock() {
                                runtime.process_event(event);
                            }
                        }
                        log::warn!("Event receiver channel closed");
                    } else {
                        log::error!("Failed to obtain event receiver!");
                    }
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
                                *board_connected_listener.write().unwrap() = true;
                                
                                // Board is already connected via shared BoardHandle
                                // Just apply pending flow if any
                                if let Some(flow) = pending_flow_board.write().unwrap().take() {
                                    log::info!("Applying pending flow: {} nodes, {} edges", 
                                        flow.nodes.len(), flow.edges.len());
                                    if let Ok(mut runtime) = flow_runtime_board.lock() {
                                        if let Err(e) = runtime.update_flow(flow) {
                                            log::error!("Failed to apply pending flow: {}", e);
                                        }
                                    }
                                }
                            }
                            Some("disconnected") => {
                                log::info!("Board disconnected");
                                *board_connected_listener.write().unwrap() = false;
                                // Board handle is already disconnected by hardware monitor
                            }
                            Some(other) => {
                                log::debug!("Board state: {}", other);
                            }
                            None => {}
                        }
                    }
                });

                // Remove the separate board-disconnected listener since we handle it above

                // Start input polling loop
                let flow_runtime_poll = Arc::clone(&flow_runtime);
                let board_connected_poll = Arc::clone(&board_connected_setup);
                std::thread::spawn(move || {
                    loop {
                        // Poll at ~100Hz for responsive input
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        
                        // Only poll if board is connected
                        if !*board_connected_poll.read().unwrap() {
                            continue;
                        }
                        
                        if let Ok(mut runtime) = flow_runtime_poll.lock() {
                            let _ = runtime.poll_inputs();
                        }
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
