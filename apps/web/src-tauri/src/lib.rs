mod hardware;
mod serial_port_manager;
mod flow;

use hardware::SidecarManager;
use serial_port_manager::SerialPortManager;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Create sidecar manager
  let sidecar_manager = Arc::new(SidecarManager::new());
  
  // Create serial port manager
  let serial_port_manager = Arc::new(Mutex::new(SerialPortManager::new()));

  tauri::Builder::default()
    .setup({
      let serial_port_manager_clone = Arc::clone(&serial_port_manager);
      move |app| {
        if cfg!(debug_assertions) {
          app.handle().plugin(
            tauri_plugin_log::Builder::default()
              .level(log::LevelFilter::Info)
              .build(),
          )?;
        }
        
        // Start serial port monitoring
        let app_handle = app.handle().clone();
        let mut manager = serial_port_manager_clone.lock().unwrap();
        manager.start_monitoring(app_handle);
        drop(manager); // Release lock
        
        Ok(())
      }
    })
    .manage(sidecar_manager)
    .manage(serial_port_manager)
    .invoke_handler(tauri::generate_handler![
      hardware::hardware_connect,
      hardware::hardware_start_blink,
      hardware::hardware_stop_blink,
      hardware::hardware_disconnect,
      hardware::hardware_get_status,
      serial_port_manager::get_available_serial_ports,
      flow::flow_update,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}