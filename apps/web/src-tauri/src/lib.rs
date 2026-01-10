mod hardware;

use hardware::SidecarManager;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Create sidecar manager
  let sidecar_manager = Arc::new(SidecarManager::new());

  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .manage(sidecar_manager)
    .invoke_handler(tauri::generate_handler![
      hardware::hardware_connect,
      hardware::hardware_start_blink,
      hardware::hardware_stop_blink,
      hardware::hardware_disconnect,
      hardware::hardware_get_status,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
