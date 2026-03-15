//! `STK500v1` protocol implementation (Uno, Nano)

use crate::flasher::boards::BoardConfig;
use crate::flasher::error::FlashError;
use std::io::{Read, Write};
use std::thread;
use std::time::Duration;

const STK_OK: u8 = 0x10;
const STK_INSYNC: u8 = 0x14;
const CRC_EOP: u8 = 0x20;
const STK_GET_SYNC: u8 = 0x30;
const STK_ENTER_PROGMODE: u8 = 0x50;
const STK_LEAVE_PROGMODE: u8 = 0x51;
const STK_LOAD_ADDRESS: u8 = 0x55;
const STK_PROG_PAGE: u8 = 0x64;
const STK_READ_SIGN: u8 = 0x75;

/// Baud rates to try for `STK500v1` bootloaders
const BAUD_RATES: &[u32] = &[57600, 115200, 19200];

pub struct Stk500v1Flasher {
    port: Box<dyn serialport::SerialPort>,
    config: BoardConfig,
    port_name: String,
}

impl Stk500v1Flasher {
    pub fn new(port_name: &str, config: BoardConfig) -> Result<Self, FlashError> {
        // Use longer timeout for bootloader communication
        let port = serialport::new(port_name, config.baud_rate)
            .timeout(Duration::from_millis(500))
            .open()
            .map_err(|e| FlashError::PortOpen(e.to_string()))?;

        Ok(Self { 
            port, 
            config,
            port_name: port_name.to_string(),
        })
    }

    pub fn flash(&mut self, hex_data: &[u8]) -> Result<(), FlashError> {
        log::info!("Starting STK500v1 flash sequence at {} baud", self.config.baud_rate);

        // Try to sync - if it fails, try other baud rates
        self.reset()?;
        
        if self.sync().is_err() {
            log::info!("Sync failed at {} baud, trying other baud rates...", self.config.baud_rate);
            
            if !self.try_alternate_baud_rates()? {
                return Err(FlashError::SyncFailed);
            }
        }

        self.verify_signature()?;
        self.enter_programming_mode()?;
        self.program_flash(hex_data)?;
        self.leave_programming_mode()?;

        log::info!("Flash completed successfully");
        Ok(())
    }

    /// Try alternate baud rates if the configured one doesn't work
    fn try_alternate_baud_rates(&mut self) -> Result<bool, FlashError> {
        for &baud in BAUD_RATES {
            if baud == self.config.baud_rate {
                continue; // Already tried this one
            }

            log::info!("Trying {baud} baud...");
            
            // Close current port and reopen at new baud rate
            drop(std::mem::replace(
                &mut self.port,
                serialport::new(&self.port_name, baud)
                    .timeout(Duration::from_millis(500))
                    .open()
                    .map_err(|e| FlashError::PortOpen(e.to_string()))?,
            ));

            self.reset()?;
            
            if self.sync().is_ok() {
                log::info!("Sync successful at {baud} baud");
                return Ok(true);
            }
        }

        Ok(false)
    }

    fn reset(&mut self) -> Result<(), FlashError> {
        log::debug!("Resetting board...");

        // Clear buffers first
        let _ = self.port.clear(serialport::ClearBuffer::All);

        // Reset sequence matching TypeScript: sendResetSignals(false, 250) then sendResetSignals(true, 50)
        // Step 1: Set DTR/RTS low for 250ms
        self.port
            .write_data_terminal_ready(false)
            .map_err(|e| FlashError::Io(e.to_string()))?;
        self.port
            .write_request_to_send(false)
            .map_err(|e| FlashError::Io(e.to_string()))?;

        thread::sleep(Duration::from_millis(250));

        // Step 2: Set DTR/RTS high for 50ms (this releases the reset line)
        self.port
            .write_data_terminal_ready(true)
            .map_err(|e| FlashError::Io(e.to_string()))?;
        self.port
            .write_request_to_send(true)
            .map_err(|e| FlashError::Io(e.to_string()))?;

        thread::sleep(Duration::from_millis(50));

        // Clear any garbage from reset
        let _ = self.port.clear(serialport::ClearBuffer::All);

        log::debug!("Reset complete");
        Ok(())
    }

    fn sync(&mut self) -> Result<(), FlashError> {
        log::info!("Syncing with bootloader...");

        // Give bootloader time to initialize after reset
        thread::sleep(Duration::from_millis(50));

        // Try multiple times (fewer attempts since we'll try other baud rates)
        for attempt in 0..8 {
            // Clear input buffer before each attempt
            let _ = self.port.clear(serialport::ClearBuffer::Input);
            
            // Small delay between attempts
            if attempt > 0 {
                thread::sleep(Duration::from_millis(50));
            }
            
            // Send sync command
            if self.port.write_all(&[STK_GET_SYNC, CRC_EOP]).is_err() {
                log::debug!("Sync attempt {}: write failed", attempt + 1);
                continue;
            }
            let _ = self.port.flush();

            // Try to read response
            thread::sleep(Duration::from_millis(10));
            
            let mut response = [0u8; 2];
            match self.port.read_exact(&mut response) {
                Ok(()) => {
                    log::info!(
                        "Sync attempt {}: got {:02X} {:02X}",
                        attempt + 1, response[0], response[1]
                    );
                    if response[0] == STK_INSYNC && response[1] == STK_OK {
                        log::info!("Sync successful on attempt {}", attempt + 1);
                        return Ok(());
                    }
                }
                Err(e) => {
                    log::debug!("Sync attempt {}: read error: {}", attempt + 1, e);
                }
            }
        }

        Err(FlashError::SyncFailed)
    }

    fn verify_signature(&mut self) -> Result<(), FlashError> {
        log::debug!("Verifying device signature...");

        self.send(&[STK_READ_SIGN, CRC_EOP])?;
        
        let mut response = [0u8; 5];
        self.port.read_exact(&mut response)
            .map_err(|e| FlashError::Communication(format!("Failed to read signature: {e}")))?;

        if response[0] != STK_INSYNC {
            return Err(FlashError::Communication(format!(
                "Invalid signature response: {response:02X?}"
            )));
        }

        let signature = &response[1..4];
        log::info!("Device signature: {signature:02X?}");
        
        if signature != self.config.signature.as_slice() {
            log::warn!(
                "Signature mismatch: expected {:02X?}, got {:02X?}",
                self.config.signature, signature
            );
            // Continue anyway - some clones have different signatures
        }

        if response[4] != STK_OK {
            return Err(FlashError::Communication("Signature read not OK".into()));
        }

        Ok(())
    }

    fn enter_programming_mode(&mut self) -> Result<(), FlashError> {
        log::debug!("Entering programming mode...");
        self.send(&[STK_ENTER_PROGMODE, CRC_EOP])?;
        self.expect_ok()
    }

    fn leave_programming_mode(&mut self) -> Result<(), FlashError> {
        log::debug!("Leaving programming mode...");
        self.send(&[STK_LEAVE_PROGMODE, CRC_EOP])?;
        self.expect_ok()
    }

    fn program_flash(&mut self, data: &[u8]) -> Result<(), FlashError> {
        let page_size = self.config.page_size;
        let total_pages = data.len().div_ceil(page_size);

        log::info!("Programming {} bytes ({} pages)", data.len(), total_pages);

        for (page_num, chunk) in data.chunks(page_size).enumerate() {
            let address = (page_num * page_size) as u16;
            let word_addr = address / 2;

            // Load address (little-endian)
            self.send(&[
                STK_LOAD_ADDRESS,
                (word_addr & 0xFF) as u8,
                ((word_addr >> 8) & 0xFF) as u8,
                CRC_EOP,
            ])?;
            self.expect_ok()?;

            // Program page
            let mut cmd = Vec::with_capacity(4 + chunk.len() + 1);
            cmd.push(STK_PROG_PAGE);
            cmd.push(((chunk.len() >> 8) & 0xFF) as u8);
            cmd.push((chunk.len() & 0xFF) as u8);
            cmd.push(b'F'); // Flash memory type
            cmd.extend_from_slice(chunk);
            cmd.push(CRC_EOP);

            self.send(&cmd)?;
            self.expect_ok()?;

            if page_num % 20 == 0 || page_num == total_pages - 1 {
                log::debug!("Progress: {}/{} pages", page_num + 1, total_pages);
            }
        }

        log::info!("Programming complete");
        Ok(())
    }

    fn send(&mut self, data: &[u8]) -> Result<(), FlashError> {
        self.port
            .write_all(data)
            .map_err(|e| FlashError::Communication(e.to_string()))?;
        self.port
            .flush()
            .map_err(|e| FlashError::Communication(e.to_string()))
    }

    fn expect_ok(&mut self) -> Result<(), FlashError> {
        let mut response = [0u8; 2];
        self.port.read_exact(&mut response)
            .map_err(|e| FlashError::Communication(format!("Read error: {e}")))?;

        if response[0] == STK_INSYNC && response[1] == STK_OK {
            Ok(())
        } else {
            Err(FlashError::Communication(format!(
                "Expected OK ({:02X} {:02X}), got {:02X} {:02X}",
                STK_INSYNC, STK_OK, response[0], response[1]
            )))
        }
    }
}
