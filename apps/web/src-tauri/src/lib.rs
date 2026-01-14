//! Microflow Tauri Application
//!
//! # Module Architecture
//!
//! ```text
//! src/
//! ├── lib.rs           - Application entry point and wiring
//! ├── hardware/        - Hardware orchestration (ports, detection, events)
//! ├── flasher/         - Firmware flashing (protocols, hex parsing)
//! └── flow.rs          - Flow execution
//! ```

mod flasher;
mod flow;
mod hardware;

use hardware::{HardwareService, SidecarManager};
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Create managers
    let sidecar_manager = Arc::new(SidecarManager::new());
    let hardware_service = Arc::new(Mutex::new(HardwareService::new()));

    tauri::Builder::default()
        .setup({
            let hardware_service = Arc::clone(&hardware_service);
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
                    .start_monitoring(app_handle);

                Ok(())
            }
        })
        .manage(sidecar_manager)
        .manage(hardware_service)
        .invoke_handler(tauri::generate_handler![
            // Hardware commands
            hardware::get_available_serial_ports,
            hardware::sidecar::hardware_connect,
            hardware::sidecar::hardware_start_blink,
            hardware::sidecar::hardware_stop_blink,
            hardware::sidecar::hardware_disconnect,
            hardware::sidecar::hardware_get_status,
            // Flasher commands
            flasher::commands::flash_firmware,
            flasher::commands::flash_standard_firmata,
            flasher::commands::auto_flash_firmata,
            flasher::commands::get_supported_boards,
            // Flow commands
            flow::flow_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
