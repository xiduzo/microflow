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
use runtime::FlowRuntime;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// Shared application state
pub struct AppState {
    pub hardware_service: Arc<Mutex<HardwareService>>,
    pub flow_runtime: Arc<Mutex<FlowRuntime>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hardware_service = Arc::new(Mutex::new(HardwareService::new()));
    let flow_runtime = Arc::new(Mutex::new(FlowRuntime::new()));

    let app_state = AppState {
        hardware_service: Arc::clone(&hardware_service),
        flow_runtime: Arc::clone(&flow_runtime),
    };

    tauri::Builder::default()
        .setup({
            let hardware_service = Arc::clone(&hardware_service);
            let flow_runtime = Arc::clone(&flow_runtime);
            move |app| {
                if cfg!(debug_assertions) {
                    app.handle().plugin(
                        tauri_plugin_log::Builder::default()
                            .level(log::LevelFilter::Info)
                            .build(),
                    )?;
                }

                // Start hardware monitoring
                let app_handle = app.handle().clone();
                hardware_service
                    .lock()
                    .unwrap()
                    .start_monitoring(app_handle.clone());

                // Set up event forwarding from flow runtime
                let app_handle_clone = app_handle.clone();
                let flow_runtime_clone = Arc::clone(&flow_runtime);
                std::thread::spawn(move || {
                    if let Some(mut rx) = flow_runtime_clone.lock().unwrap().take_event_receiver() {
                        while let Some(event) = rx.blocking_recv() {
                            let _ = app_handle_clone.emit("component-event", &event);
                            if let Ok(mut runtime) = flow_runtime_clone.lock() {
                                runtime.process_event(event);
                            }
                        }
                    }
                });

                // Start input polling loop
                let flow_runtime_poll = Arc::clone(&flow_runtime);
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        if let Ok(mut runtime) = flow_runtime_poll.lock() {
                            if runtime.board_manager().is_connected() {
                                let _ = runtime.poll_inputs();
                            }
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
