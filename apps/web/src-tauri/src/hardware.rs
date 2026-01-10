use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Response from hardware operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareResponse {
    pub success: bool,
    pub message: String,
}

/// Hardware status information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareStatus {
    pub connected: bool,
    pub blinking: bool,
    pub pin: Option<u8>,
    pub interval: Option<u32>,
}

/// Sidecar command to send to the Node.js worker
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

/// Sidecar response from the Node.js worker
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
                // Process is still running
                return Ok(());
            }
        }

        // Determine the sidecar script path
        // In dev mode, use the source directory
        // In production, use the bundled resources
        let sidecar_script = if cfg!(debug_assertions) {
            // Dev mode: use source directory
            let current_dir = std::env::current_dir()
                .map_err(|e| format!("Failed to get current dir: {}", e))?;
            current_dir.join("sidecar/dist/hardware-worker.js")
        } else {
            // Production mode: use bundled resources
            let resource_path = app_handle
                .path()
                .resource_dir()
                .map_err(|e| format!("Failed to get resource dir: {}", e))?;
            resource_path.join("sidecar/dist/hardware-worker.js")
        };

        eprintln!("Starting sidecar from: {:?}", sidecar_script);

        // Verify the script exists
        if !sidecar_script.exists() {
            return Err(format!(
                "Sidecar script not found at: {:?}. Please ensure the sidecar is built.",
                sidecar_script
            ));
        }

        // Spawn the sidecar process using Node.js
        let child = Command::new("node")
            .arg(&sidecar_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar process: {}", e))?;

        *process_guard = Some(child);
        
        // Reset restart count on successful start
        let mut restart_count = self.restart_count.lock().unwrap();
        *restart_count = 0;
        
        Ok(())
    }

    /// Stop the sidecar process
    pub fn stop(&self) -> Result<(), String> {
        let mut process_guard = self.process.lock().unwrap();

        if let Some(mut child) = process_guard.take() {
            child
                .kill()
                .map_err(|e| format!("Failed to kill sidecar process: {}", e))?;
            child
                .wait()
                .map_err(|e| format!("Failed to wait for sidecar process: {}", e))?;
        }

        Ok(())
    }

    /// Restart the sidecar process
    pub fn restart(&self, app_handle: &tauri::AppHandle) -> Result<(), String> {
        let mut restart_count = self.restart_count.lock().unwrap();
        
        // Check if we've exceeded max restarts
        if *restart_count >= self.max_restarts {
            return Err(format!(
                "Sidecar has crashed {} times. Maximum restart attempts ({}) exceeded. Please restart the application.",
                *restart_count,
                self.max_restarts
            ));
        }
        
        *restart_count += 1;
        drop(restart_count); // Release lock before calling stop/start
        
        eprintln!("Restarting sidecar process (attempt {})", *self.restart_count.lock().unwrap());
        
        self.stop()?;
        std::thread::sleep(Duration::from_millis(500));
        self.start(app_handle)?;
        
        Ok(())
    }

    /// Check if the sidecar process is running
    pub fn is_running(&self) -> bool {
        let mut process_guard = self.process.lock().unwrap();
        
        if let Some(ref mut child) = *process_guard {
            // Check if process has exited
            match child.try_wait() {
                Ok(None) => true,  // Process is still running
                Ok(Some(status)) => {
                    eprintln!("Sidecar process exited with status: {:?}", status);
                    false
                }
                Err(e) => {
                    eprintln!("Error checking sidecar process status: {}", e);
                    false
                }
            }
        } else {
            false
        }
    }

    /// Detect if sidecar has crashed and attempt recovery
    fn check_and_recover(&self, app_handle: &tauri::AppHandle) -> Result<(), String> {
        if !self.is_running() {
            eprintln!("Sidecar process has crashed. Attempting to restart...");
            
            // Emit event to notify frontend
            let _ = app_handle.emit("sidecar-crashed", ());
            
            self.restart(app_handle)?;
            
            // Emit event to notify frontend of successful restart
            let _ = app_handle.emit("sidecar-restarted", ());
        }
        
        Ok(())
    }

    /// Send a command to the sidecar and wait for response
    fn send_command(
        &self,
        command: SidecarCommand,
        _timeout_secs: u64,
        app_handle: &tauri::AppHandle,
    ) -> Result<SidecarResponse, String> {
        // Check if sidecar is running, attempt recovery if not
        self.check_and_recover(app_handle)?;
        
        let mut process_guard = self.process.lock().unwrap();

        let child = process_guard
            .as_mut()
            .ok_or_else(|| "Sidecar process not running".to_string())?;

        // Get stdin and stdout
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "Failed to get stdin".to_string())?;
        let stdout = child
            .stdout
            .as_mut()
            .ok_or_else(|| "Failed to get stdout".to_string())?;

        // Serialize and send command
        let command_json = serde_json::to_string(&command)
            .map_err(|e| format!("Failed to serialize command: {}", e))?;
        
        eprintln!("Sending command to sidecar: {}", command_json);
        
        writeln!(stdin, "{}", command_json)
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        
        stdin
            .flush()
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        eprintln!("Command sent, waiting for response...");

        // Read response with timeout
        let mut reader = BufReader::new(stdout);
        let mut response_line = String::new();

        // Use a simple blocking read with timeout
        // Note: This is a simplified implementation. In production, you'd want
        // to use async I/O or a more sophisticated timeout mechanism
        reader
            .read_line(&mut response_line)
            .map_err(|e| format!("Failed to read response: {}", e))?;

        eprintln!("Received response: {}", response_line);

        // Parse response
        let response: SidecarResponse = serde_json::from_str(&response_line)
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        Ok(response)
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

// Tauri Commands

/// Connect to the Arduino board
#[tauri::command]
pub async fn hardware_connect(
    port: Option<String>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareResponse, String> {
    // Start sidecar if not running
    if !sidecar.is_running() {
        sidecar.start(&app_handle)?;
        // Give the sidecar a moment to initialize
        std::thread::sleep(Duration::from_millis(500));
    }

    // Send connect command
    let command = SidecarCommand::Connect { port };
    let response = sidecar.send_command(command, 5, &app_handle)?;

    Ok(HardwareResponse {
        success: response.success,
        message: response.message.unwrap_or_else(|| "No message".to_string()),
    })
}

/// Start blinking an LED on the specified pin
#[tauri::command]
pub async fn hardware_start_blink(
    pin: u8,
    interval: u32,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareResponse, String> {
    // Send startBlink command
    let command = SidecarCommand::StartBlink { pin, interval };
    let response = sidecar.send_command(command, 5, &app_handle)?;

    Ok(HardwareResponse {
        success: response.success,
        message: response.message.unwrap_or_else(|| "No message".to_string()),
    })
}

/// Stop the LED from blinking
#[tauri::command]
pub async fn hardware_stop_blink(
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareResponse, String> {
    // Send stopBlink command
    let command = SidecarCommand::StopBlink;
    let response = sidecar.send_command(command, 5, &app_handle)?;

    Ok(HardwareResponse {
        success: response.success,
        message: response.message.unwrap_or_else(|| "No message".to_string()),
    })
}

/// Disconnect from the Arduino board
#[tauri::command]
pub async fn hardware_disconnect(
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareResponse, String> {
    // Send disconnect command
    let command = SidecarCommand::Disconnect;
    let response = sidecar.send_command(command, 5, &app_handle)?;

    Ok(HardwareResponse {
        success: response.success,
        message: response.message.unwrap_or_else(|| "No message".to_string()),
    })
}

/// Get the current hardware status
#[tauri::command]
pub async fn hardware_get_status(
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    app_handle: tauri::AppHandle,
) -> Result<HardwareStatus, String> {
    // Send getStatus command
    let command = SidecarCommand::GetStatus;
    let response = sidecar.send_command(command, 5, &app_handle)?;

    if !response.success {
        return Err(response.message.unwrap_or_else(|| "Failed to get status".to_string()));
    }

    // Parse the data field
    let data = response.data.ok_or_else(|| "No status data returned".to_string())?;
    
    let status: HardwareStatus = serde_json::from_value(data)
        .map_err(|e| format!("Failed to parse status data: {}", e))?;

    Ok(status)
}
