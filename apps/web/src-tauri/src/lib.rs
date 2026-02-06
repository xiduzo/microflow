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

mod flasher;
mod hardware;
mod mqtt;
mod runtime;

use hardware::HardwareService;
use mqtt::MqttManager;
use runtime::{FlowRuntime, FlowUpdate};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{Emitter, Listener};
use tokio::sync::mpsc;

/// MQTT publish request from flow components
#[derive(Debug, Clone)]
pub struct MqttPublishRequest {
    pub component_id: String,
    pub broker_id: String,
    pub topic: String,
    pub payload: String,
    pub retain: bool,
}

/// Shared application state
pub struct AppState {
    pub hardware_service: Arc<Mutex<HardwareService>>,
    pub flow_runtime: Arc<Mutex<FlowRuntime>>,
    /// Pending flow update to apply when board connects
    pub pending_flow: Arc<RwLock<Option<FlowUpdate>>>,
    /// Whether a Firmata board is connected
    pub board_connected: Arc<RwLock<bool>>,
    /// MQTT broker manager
    pub mqtt_manager: MqttManager,
    /// Channel for MQTT publish requests from flow components
    pub mqtt_publish_tx: mpsc::UnboundedSender<MqttPublishRequest>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize rustls crypto provider for TLS connections
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    let hardware_service = Arc::new(Mutex::new(HardwareService::new()));
    let flow_runtime = Arc::new(Mutex::new(FlowRuntime::new()));
    let pending_flow = Arc::new(RwLock::new(None));
    let board_connected = Arc::new(RwLock::new(false));
    
    // Create channel for MQTT publish requests
    let (mqtt_publish_tx, mqtt_publish_rx) = mpsc::unbounded_channel::<MqttPublishRequest>();

    let mqtt_manager = MqttManager::new();
    let mqtt_manager_for_publish = mqtt_manager.clone();

    let app_state = AppState {
        hardware_service: Arc::clone(&hardware_service),
        flow_runtime: Arc::clone(&flow_runtime),
        pending_flow: Arc::clone(&pending_flow),
        board_connected: Arc::clone(&board_connected),
        mqtt_manager,
        mqtt_publish_tx: mqtt_publish_tx.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
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
                let mqtt_publish_tx_events = mqtt_publish_tx.clone();
                std::thread::spawn(move || {
                    log::info!("Event forwarding thread started");
                    if let Some(mut rx) = event_rx {
                        log::info!("Event receiver obtained, waiting for events...");
                        while let Some(event) = rx.blocking_recv() {
                            log::info!("Received event: {} ({}) -> {:?}", 
                                event.source, event.source_handle, event.value);
                            
                            // Handle MQTT publish events specially
                            // These are emitted by MQTT publish nodes when they receive input
                            if event.source_handle == "_mqtt_publish" {
                                log::info!("[MQTT] Publish event from component {}", event.source);
                                
                                // Parse the JSON publish info from the event value
                                if let runtime::ComponentValue::String(json_str) = &event.value {
                                    if let Ok(publish_info) = serde_json::from_str::<serde_json::Value>(json_str) {
                                        let broker_id = publish_info.get("brokerId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let topic = publish_info.get("topic").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let payload = publish_info.get("payload").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let retain = publish_info.get("retain").and_then(|v| v.as_bool()).unwrap_or(false);
                                        
                                        log::info!("[MQTT] Publishing to broker={}, topic={}, payload={}, retain={}", 
                                            broker_id, topic, payload, retain);
                                        
                                        if !broker_id.is_empty() && !topic.is_empty() {
                                            let _ = mqtt_publish_tx_events.send(MqttPublishRequest {
                                                component_id: event.source.clone(),
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
                            if let Ok(mut runtime) = flow_runtime_events.lock() {
                                runtime.process_event(event);
                            }
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
                                    log::error!("[MQTT] Failed to publish: {}", e);
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
                                *board_connected_listener.write().unwrap() = true;
                                
                                // Apply pending flow if any, which will also install the callback
                                if let Some(flow) = pending_flow_board.write().unwrap().take() {
                                    log::info!("Applying pending flow: {} nodes, {} edges", 
                                        flow.nodes.len(), flow.edges.len());
                                    if let Ok(mut runtime) = flow_runtime_board.lock() {
                                        if let Err(e) = runtime.update_flow(flow) {
                                            log::error!("Failed to apply pending flow: {}", e);
                                        } else {
                                            // Install pin change callback after flow update
                                            let event_tx = runtime.event_sender();
                                            runtime.install_pin_change_callback(event_tx);
                                            // Start the dedicated reader thread
                                            runtime.board_handle().start_reader();
                                        }
                                    }
                                } else {
                                    // No pending flow, but still install callback and start reader
                                    if let Ok(runtime) = flow_runtime_board.lock() {
                                        let event_tx = runtime.event_sender();
                                        runtime.install_pin_change_callback(event_tx);
                                        // Start the dedicated reader thread
                                        runtime.board_handle().start_reader();
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
            mqtt::commands::mqtt_connect,
            mqtt::commands::mqtt_disconnect,
            mqtt::commands::mqtt_subscribe,
            mqtt::commands::mqtt_unsubscribe,
            mqtt::commands::mqtt_publish,
            mqtt::commands::mqtt_status,
            mqtt::commands::mqtt_connected_brokers,
            mqtt::commands::mqtt_sync_brokers,
            mqtt::commands::mqtt_all_statuses,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
