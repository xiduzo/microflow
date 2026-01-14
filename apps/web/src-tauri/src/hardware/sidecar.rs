//! Node.js sidecar management for hardware communication
//!
//! This module manages a Node.js process that handles real-time
//! Firmata communication. The Rust side handles discovery and flashing,
//! while the Node.js sidecar handles the actual board communication.

use super::types::{HardwareResponse, HardwareStatus};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Command to send to the Node.js worker
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SidecarCommand {
    #[serde(rename = "connect")]
    Connect { port: Option<String> },
    #[serde(rename = "startBlink")]
    StartBlink { pin: u8, interval: u32 },
    #[serde(rename = "stopBlink")]
    StopBlink,
    #[serde(rename = "disconnect")]
    Disconnect,
    #[serde(rename = "getStatus")]
    GetStatus,
}

/// Response from the Node.js worker
#[derive(Debug, Deserialize)]
struct SidecarResponse {
    success: bool,
    message: Option<String>,
    data: Option<serde_json::Value>,
}

/// Manages the sidecar process lifecycle and communication
pub struct SidecarManager {
    process: Arc<Mutex<Option<Child>>>,
    restart_count: Arc<Mutex<u32>>,
    max_restarts: u32,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            restart_count: Arc::new(Mutex::new(0)),
            max_restarts: 3,
        }
    }

    /// Start the sidecar process
    pub fn start(&self, app_handle: &tauri::AppHandle) -> Result<(), String> {
        let mut process_guard = self.process.lock().unwrap();

        // Check if already running
        if let Some(ref mut child) = *process_guard {
            if let Ok(None) = child.try_wait() {
                return Ok(());
            }
        }

        let sidecar_script = Self::get_sidecar_path(app_handle)?;

        if !sidecar_script.exists() {
            return Err(format!(
                "Sidecar script not found at: {:?}. Please ensure the sidecar is built.",
                sidecar_script
            ));
        }

        let child = Command::new("node")
            .arg(&sidecar_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        *process_guard = Some(child);

        // Reset restart count
        *self.restart_count.lock().unwrap() = 0;

        Ok(())
    }

    /// Stop the sidecar process
    pub fn stop(&self) -> Result<(), String> {
        let mut process_guard = self.process.lock().unwrap();

        if let Some(mut child) = process_guard.take() {
            child.kill().map_err(|e| format!("Failed to kill sidecar: {}", e))?;
            child.wait().map_err(|e| format!("Failed to wait for sidecar: {}", e))?;
        }

        Ok(())
    }

    /// Check if the sidecar is running
    pub fn is_running(&self) -> bool {
        let mut process_guard = self.process.lock().unwrap();

        if let Some(ref mut child) = *process_guard {
            matches!(child.try_wait(), Ok(None))
        } else {
            false
        }
    }

    /// Restart the sidecar
    fn restart(&self, app_handle: &tauri::AppHandle) -> Result<(), String> {
        let mut restart_count = self.restart_count.lock().unwrap();

        if *restart_count >= self.max_restarts {
            return Err(format!(
                "Sidecar crashed {} times. Max restarts ({}) exceeded.",
                *restart_count, self.max_restarts
            ));
        }

        *restart_count += 1;
        drop(restart_count);

        self.stop()?;
        std::thread::sleep(Duration::from_millis(500));
        self.start(app_handle)
    }

    /// Check and recover if sidecar crashed
    fn check_and_recover(&self, app_handle: &tauri::AppHandle) -> Result<(), String> {
        if !self.is_running() {
            let _ = app_handle.emit("sidecar-crashed", ());
            self.restart(app_handle)?;
            let _ = app_handle.emit("sidecar-restarted", ());
        }
        Ok(())
    }

    /// Send a command to the sidecar
    fn send_command(
        &self,
        command: SidecarCommand,
        app_handle: &tauri::AppHandle,
    ) -> Result<SidecarResponse, String> {
        self.check_and_recover(app_handle)?;

        let mut process_guard = self.process.lock().unwrap();
        let child = process_guard
            .as_mut()
            .ok_or("Sidecar not running")?;

        let stdin = child.stdin.as_mut().ok_or("No stdin")?;
        let stdout = child.stdout.as_mut().ok_or("No stdout")?;

        let command_json =
            serde_json::to_string(&command).map_err(|e| format!("Serialize error: {}", e))?;

        writeln!(stdin, "{}", command_json).map_err(|e| format!("Write error: {}", e))?;
        stdin.flush().map_err(|e| format!("Flush error: {}", e))?;

        let mut reader = BufReader::new(stdout);
        let mut response_line = String::new();
        reader
            .read_line(&mut response_line)
            .map_err(|e| format!("Read error: {}", e))?;

        serde_json::from_str(&response_line).map_err(|e| format!("Parse error: {}", e))
    }

    fn get_sidecar_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        if cfg!(debug_assertions) {
            let current_dir =
                std::env::current_dir().map_err(|e| format!("Failed to get current dir: {}", e))?;
            Ok(current_dir.join("sidecar/dist/hardware-worker.js"))
        } else {
            let resource_path = app_handle
                .path()
                .resource_dir()
                .map_err(|e| format!("Failed to get resource dir: {}", e))?;
            Ok(resource_path.join("sidecar/dist/hardware-worker.js"))
        }
    }
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn hardware_connect(
    port: Option<String>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareResponse, String> {
    if !sidecar.is_running() {
        sidecar.start(&app_handle)?;
        std::thread::sleep(Duration::from_millis(500));
    }

    let response = sidecar.send_command(SidecarCommand::Connect { port }, &app_handle)?;

    Ok(HardwareResponse {
        success: response.success,
        message: response.message.unwrap_or_else(|| "No message".to_string()),
    })
}

#[tauri::command]
pub async fn hardware_start_blink(
    pin: u8,
    interval: u32,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareResponse, String> {
    let response =
        sidecar.send_command(SidecarCommand::StartBlink { pin, interval }, &app_handle)?;

    Ok(HardwareResponse {
        success: response.success,
        message: response.message.unwrap_or_else(|| "No message".to_string()),
    })
}

#[tauri::command]
pub async fn hardware_stop_blink(
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareResponse, String> {
    let response = sidecar.send_command(SidecarCommand::StopBlink, &app_handle)?;

    Ok(HardwareResponse {
        success: response.success,
        message: response.message.unwrap_or_else(|| "No message".to_string()),
    })
}

#[tauri::command]
pub async fn hardware_disconnect(
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareResponse, String> {
    let response = sidecar.send_command(SidecarCommand::Disconnect, &app_handle)?;

    Ok(HardwareResponse {
        success: response.success,
        message: response.message.unwrap_or_else(|| "No message".to_string()),
    })
}

#[tauri::command]
pub async fn hardware_get_status(
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareStatus, String> {
    let response = sidecar.send_command(SidecarCommand::GetStatus, &app_handle)?;

    if !response.success {
        return Err(response.message.unwrap_or_else(|| "Failed to get status".to_string()));
    }

    let data = response.data.ok_or("No status data")?;
    serde_json::from_value(data).map_err(|e| format!("Parse error: {}", e))
}
