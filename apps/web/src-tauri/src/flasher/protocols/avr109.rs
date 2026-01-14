//! AVR109 protocol implementation (Leonardo, Micro)

use crate::flasher::boards::BoardConfig;
use crate::flasher::error::FlashError;
use std::io::{Read, Write};
use std::thread;
use std::time::Duration;

pub struct Avr109Flasher {
    port_name: String,
    config: BoardConfig,
}

impl Avr109Flasher {
    pub fn new(port_name: &str, config: BoardConfig) -> Self {
        Self {
            port_name: port_name.to_string(),
            config,
        }
    }

    pub fn flash(&mut self, hex_data: &[u8]) -> Result<(), FlashError> {
        log::info!("Starting AVR109 flash sequence");

        // Step 1: Reset to bootloader mode (1200 baud touch)
        self.reset_to_bootloader()?;

        // Step 2: Wait for bootloader to appear
        let bootloader_port = self.wait_for_bootloader()?;
        log::info!("Bootloader ready on {}", bootloader_port);

        // Step 3: Open port and flash
        let mut port = self.open_bootloader_port(&bootloader_port)?;

        self.sync(&mut port)?;
        self.erase(&mut port)?;
        self.program(&mut port, hex_data)?;
        self.exit_bootloader(&mut port)?;

        log::info!("Flash completed successfully");
        Ok(())
    }

    fn reset_to_bootloader(&self) -> Result<(), FlashError> {
        log::debug!("Resetting board to bootloader mode (1200 baud touch)...");

        // Open at 1200 baud - this is the "1200 baud touch" that triggers bootloader
        let mut port = serialport::new(&self.port_name, 1200)
            .timeout(Duration::from_millis(1000))
            .open()
            .map_err(|e| FlashError::PortOpen(format!("Failed to open for reset: {}", e)))?;

        // Set DTR/RTS low (false) - matches TypeScript: sendResetSignals(false, 250)
        port.write_data_terminal_ready(false)
            .map_err(|e| FlashError::Io(e.to_string()))?;
        port.write_request_to_send(false)
            .map_err(|e| FlashError::Io(e.to_string()))?;
        
        thread::sleep(Duration::from_millis(250));

        // Close port - the combination of 1200 baud + DTR low + close triggers bootloader
        drop(port);
        
        log::debug!("Reset signal sent, waiting for bootloader...");
        Ok(())
    }

    fn wait_for_bootloader(&self) -> Result<String, FlashError> {
        log::debug!("Waiting for bootloader to appear...");

        // Wait a bit for the board to disconnect and reconnect in bootloader mode
        thread::sleep(Duration::from_millis(500));

        // Try to find the port again (bootloader may appear on same or different port)
        for attempt in 0..30 {
            thread::sleep(Duration::from_millis(100));

            if let Ok(ports) = serialport::available_ports() {
                // Log available ports on first few attempts for debugging
                if attempt < 3 || attempt % 10 == 0 {
                    let port_names: Vec<_> = ports.iter().map(|p| p.port_name.as_str()).collect();
                    log::debug!("Attempt {}: available ports: {:?}", attempt + 1, port_names);
                }

                // First, check if original port is back
                if ports.iter().any(|p| p.port_name == self.port_name) {
                    // Try to open it to verify it's ready
                    if serialport::new(&self.port_name, self.config.baud_rate)
                        .timeout(Duration::from_millis(100))
                        .open()
                        .is_ok()
                    {
                        log::info!("Bootloader found on original port after {} attempts", attempt + 1);
                        return Ok(self.port_name.clone());
                    }
                }

                // Also look for any new USB serial port (Leonardo bootloader might appear differently)
                for port in &ports {
                    if port.port_name.contains("usbmodem") || port.port_name.contains("ttyACM") {
                        if serialport::new(&port.port_name, self.config.baud_rate)
                            .timeout(Duration::from_millis(100))
                            .open()
                            .is_ok()
                        {
                            log::info!("Bootloader found on {} after {} attempts", port.port_name, attempt + 1);
                            return Ok(port.port_name.clone());
                        }
                    }
                }
            }
        }

        Err(FlashError::BoardNotFound(format!(
            "Bootloader not found after reset (original port: {})",
            self.port_name
        )))
    }

    fn open_bootloader_port(&self, port_name: &str) -> Result<Box<dyn serialport::SerialPort>, FlashError> {
        // Bootloader uses 57600 baud for AVR109
        let port = serialport::new(port_name, self.config.baud_rate)
            .timeout(Duration::from_millis(2000))
            .open()
            .map_err(|e| FlashError::PortOpen(format!("Failed to open bootloader port: {}", e)))?;
        
        // Give the port a moment to stabilize
        thread::sleep(Duration::from_millis(100));
        
        Ok(port)
    }

    fn sync(&self, port: &mut Box<dyn serialport::SerialPort>) -> Result<(), FlashError> {
        log::info!("Syncing with AVR109 bootloader...");

        // Clear any pending data
        let _ = port.clear(serialport::ClearBuffer::All);
        thread::sleep(Duration::from_millis(100));

        // Try sync multiple times
        for attempt in 0..5 {
            // Send 'S' to get software identifier (7 bytes expected: "CATERIN")
            if port.write_all(&[b'S']).is_err() {
                log::debug!("Sync attempt {}: write failed", attempt + 1);
                continue;
            }
            let _ = port.flush();

            // Give bootloader time to respond
            thread::sleep(Duration::from_millis(50));

            let mut response = [0u8; 7];
            match port.read_exact(&mut response) {
                Ok(_) => {
                    let id = String::from_utf8_lossy(&response);
                    log::info!("Bootloader ID: '{}' (attempt {})", id, attempt + 1);
                    
                    if id.contains("CATER") {
                        return Ok(());
                    }
                }
                Err(e) => {
                    log::debug!("Sync attempt {} failed: {}", attempt + 1, e);
                    thread::sleep(Duration::from_millis(100));
                    let _ = port.clear(serialport::ClearBuffer::All);
                }
            }
        }

        Err(FlashError::SyncFailed)
    }

    fn erase(&self, port: &mut Box<dyn serialport::SerialPort>) -> Result<(), FlashError> {
        log::debug!("Erasing chip...");

        // Clear buffer before erase
        let _ = port.clear(serialport::ClearBuffer::Input);

        port.write_all(&[b'e'])
            .map_err(|e| FlashError::Communication(format!("Failed to send erase: {}", e)))?;
        let _ = port.flush();

        // Wait for erase to complete - can take a moment
        thread::sleep(Duration::from_millis(100));

        let mut response = [0u8; 1];
        port.read_exact(&mut response)
            .map_err(|e| FlashError::Communication(format!("Erase response error: {}", e)))?;

        if response[0] != b'\r' {
            return Err(FlashError::ProgramFailed(format!(
                "Erase failed, got: 0x{:02X} (expected 0x0D)",
                response[0]
            )));
        }

        log::debug!("Erase complete");
        Ok(())
    }

    fn program(
        &self,
        port: &mut Box<dyn serialport::SerialPort>,
        data: &[u8],
    ) -> Result<(), FlashError> {
        log::info!("Programming {} bytes", data.len());

        // Set address to 0 (word address)
        port.write_all(&[b'A', 0, 0])
            .map_err(|e| FlashError::Communication(e.to_string()))?;
        port.flush().ok();

        let mut response = [0u8; 1];
        port.read_exact(&mut response)
            .map_err(|e| FlashError::Communication(e.to_string()))?;

        if response[0] != b'\r' {
            return Err(FlashError::ProgramFailed("Failed to set address".into()));
        }

        // Program in blocks
        let block_size = 128;
        let total_blocks = (data.len() + block_size - 1) / block_size;
        
        for (i, chunk) in data.chunks(block_size).enumerate() {
            let len = chunk.len() as u16;

            // Block write command: 'B' + length (big endian) + 'F' (flash) + data
            let mut cmd = Vec::with_capacity(4 + chunk.len());
            cmd.push(b'B');
            cmd.push((len >> 8) as u8);
            cmd.push((len & 0xFF) as u8);
            cmd.push(b'F');
            cmd.extend_from_slice(chunk);

            port.write_all(&cmd)
                .map_err(|e| FlashError::Communication(e.to_string()))?;
            port.flush().ok();
            
            port.read_exact(&mut response)
                .map_err(|e| FlashError::Communication(format!("Block {} write error: {}", i, e)))?;

            if response[0] != b'\r' {
                return Err(FlashError::ProgramFailed(format!(
                    "Block write failed at block {}, got: 0x{:02X}",
                    i, response[0]
                )));
            }

            if i % 25 == 0 || i == total_blocks - 1 {
                log::debug!("Progress: {}/{} blocks", i + 1, total_blocks);
            }
        }

        log::info!("Programming complete");
        Ok(())
    }

    fn exit_bootloader(&self, port: &mut Box<dyn serialport::SerialPort>) -> Result<(), FlashError> {
        log::debug!("Exiting bootloader, starting application...");
        
        // Send 'E' to exit bootloader and start application
        port.write_all(&[b'E'])
            .map_err(|e| FlashError::Communication(e.to_string()))?;
        port.flush().ok();
        
        // Give the board time to reset
        thread::sleep(Duration::from_millis(100));
        
        Ok(())
    }
}
