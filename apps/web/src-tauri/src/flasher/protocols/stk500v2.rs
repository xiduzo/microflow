//! STK500v2 protocol implementation (Mega 2560)
//!
//! The STK500v2 protocol is more complex than v1, using a packet-based
//! communication with sequence numbers and checksums.

use crate::flasher::boards::BoardConfig;
use crate::flasher::error::FlashError;
use std::io::{Read, Write};
use std::thread;
use std::time::Duration;

// STK500v2 message constants
const MESSAGE_START: u8 = 0x1B;
const TOKEN: u8 = 0x0E;

// Commands
const CMD_SIGN_ON: u8 = 0x01;
const CMD_LOAD_ADDRESS: u8 = 0x06;
const CMD_ENTER_PROGMODE_ISP: u8 = 0x10;
const CMD_LEAVE_PROGMODE_ISP: u8 = 0x11;
const CMD_PROGRAM_FLASH_ISP: u8 = 0x13;
const CMD_READ_SIGNATURE_ISP: u8 = 0x1B;

// Status codes
const STATUS_CMD_OK: u8 = 0x00;

pub struct Stk500v2Flasher {
    port: Box<dyn serialport::SerialPort>,
    config: BoardConfig,
    sequence: u8,
}

impl Stk500v2Flasher {
    pub fn new(port_name: &str, config: BoardConfig) -> Result<Self, FlashError> {
        let port = serialport::new(port_name, config.baud_rate)
            .timeout(Duration::from_millis(1000))
            .open()
            .map_err(|e| FlashError::PortOpen(e.to_string()))?;

        Ok(Self {
            port,
            config,
            sequence: 0,
        })
    }

    pub fn flash(&mut self, hex_data: &[u8]) -> Result<(), FlashError> {
        log::info!(
            "Starting STK500v2 flash sequence at {} baud",
            self.config.baud_rate
        );

        self.reset()?;
        self.sign_on()?;
        self.enter_programming_mode()?;
        self.verify_signature()?;
        self.program_flash(hex_data)?;
        self.leave_programming_mode()?;

        log::info!("Flash completed successfully");
        Ok(())
    }

    fn reset(&mut self) -> Result<(), FlashError> {
        log::debug!("Resetting board...");

        let _ = self.port.clear(serialport::ClearBuffer::All);

        // Toggle DTR to reset
        self.port
            .write_data_terminal_ready(false)
            .map_err(|e| FlashError::Io(e.to_string()))?;
        thread::sleep(Duration::from_millis(250));

        self.port
            .write_data_terminal_ready(true)
            .map_err(|e| FlashError::Io(e.to_string()))?;
        thread::sleep(Duration::from_millis(50));

        let _ = self.port.clear(serialport::ClearBuffer::All);

        Ok(())
    }

    fn sign_on(&mut self) -> Result<(), FlashError> {
        log::debug!("Signing on...");

        // Try multiple times
        for attempt in 0..5 {
            let _ = self.port.clear(serialport::ClearBuffer::Input);

            if attempt > 0 {
                thread::sleep(Duration::from_millis(100));
            }

            let response = self.send_command(&[CMD_SIGN_ON]);
            match response {
                Ok(data) if !data.is_empty() && data[0] == STATUS_CMD_OK => {
                    log::info!("Sign-on successful on attempt {}", attempt + 1);
                    return Ok(());
                }
                Ok(data) => {
                    log::debug!("Sign-on attempt {}: unexpected response {:02X?}", attempt + 1, data);
                }
                Err(e) => {
                    log::debug!("Sign-on attempt {}: {}", attempt + 1, e);
                }
            }
        }

        Err(FlashError::SyncFailed)
    }

    fn enter_programming_mode(&mut self) -> Result<(), FlashError> {
        log::debug!("Entering programming mode...");

        // ISP programming parameters for ATmega2560
        let params = [
            CMD_ENTER_PROGMODE_ISP,
            200, // timeout
            100, // stabDelay
            25,  // cmdexeDelay
            32,  // synchLoops
            0,   // byteDelay
            0x53, // pollValue
            3,   // pollIndex
            0xAC, 0x53, 0x00, 0x00, // cmd bytes
        ];

        let response = self.send_command(&params)?;
        if response.is_empty() || response[0] != STATUS_CMD_OK {
            return Err(FlashError::Communication(
                "Failed to enter programming mode".into(),
            ));
        }

        Ok(())
    }

    fn leave_programming_mode(&mut self) -> Result<(), FlashError> {
        log::debug!("Leaving programming mode...");

        let params = [
            CMD_LEAVE_PROGMODE_ISP,
            1, // preDelay
            1, // postDelay
        ];

        let response = self.send_command(&params)?;
        if response.is_empty() || response[0] != STATUS_CMD_OK {
            return Err(FlashError::Communication(
                "Failed to leave programming mode".into(),
            ));
        }

        Ok(())
    }

    fn verify_signature(&mut self) -> Result<(), FlashError> {
        log::debug!("Verifying device signature...");

        let mut signature = Vec::new();

        for i in 0..3 {
            let cmd = [
                CMD_READ_SIGNATURE_ISP,
                4,    // retAddr
                0x30, // cmd1
                0x00, // cmd2
                i,    // cmd3 (signature byte index)
                0x00, // cmd4
            ];

            let response = self.send_command(&cmd)?;
            if response.len() < 3 || response[0] != STATUS_CMD_OK {
                return Err(FlashError::Communication(
                    "Failed to read signature".into(),
                ));
            }
            signature.push(response[2]);
        }

        log::info!("Device signature: {:02X?}", signature);

        if signature != self.config.signature {
            log::warn!(
                "Signature mismatch: expected {:02X?}, got {:02X?}",
                self.config.signature,
                signature
            );
        }

        Ok(())
    }

    fn program_flash(&mut self, data: &[u8]) -> Result<(), FlashError> {
        let page_size = self.config.page_size;
        let total_pages = (data.len() + page_size - 1) / page_size;

        log::info!("Programming {} bytes ({} pages)", data.len(), total_pages);

        for (page_num, chunk) in data.chunks(page_size).enumerate() {
            let address = (page_num * page_size) as u32;

            // Load extended address if needed (for >64KB)
            self.load_address(address)?;

            // Program page
            self.program_page(chunk)?;

            if page_num % 10 == 0 || page_num == total_pages - 1 {
                log::debug!("Progress: {}/{} pages", page_num + 1, total_pages);
            }
        }

        log::info!("Programming complete");
        Ok(())
    }

    fn load_address(&mut self, address: u32) -> Result<(), FlashError> {
        // STK500v2 uses byte addresses, convert to word address
        let word_addr = address / 2;

        let cmd = [
            CMD_LOAD_ADDRESS,
            ((word_addr >> 24) & 0xFF) as u8,
            ((word_addr >> 16) & 0xFF) as u8,
            ((word_addr >> 8) & 0xFF) as u8,
            (word_addr & 0xFF) as u8,
        ];

        let response = self.send_command(&cmd)?;
        if response.is_empty() || response[0] != STATUS_CMD_OK {
            return Err(FlashError::Communication("Failed to load address".into()));
        }

        Ok(())
    }

    fn program_page(&mut self, data: &[u8]) -> Result<(), FlashError> {
        let len = data.len();

        let mut cmd = Vec::with_capacity(10 + len);
        cmd.push(CMD_PROGRAM_FLASH_ISP);
        cmd.push(((len >> 8) & 0xFF) as u8);
        cmd.push((len & 0xFF) as u8);
        cmd.push(0xC1); // mode
        cmd.push(10);   // delay
        cmd.push(0x40); // cmd1
        cmd.push(0x4C); // cmd2
        cmd.push(0x20); // cmd3
        cmd.push(0x00); // poll1
        cmd.push(0x00); // poll2
        cmd.extend_from_slice(data);

        let response = self.send_command(&cmd)?;
        if response.is_empty() || response[0] != STATUS_CMD_OK {
            return Err(FlashError::ProgramFailed("Page write failed".into()));
        }

        Ok(())
    }

    fn send_command(&mut self, body: &[u8]) -> Result<Vec<u8>, FlashError> {
        let packet = self.build_packet(body);
        self.send_raw(&packet)?;
        self.receive_response()
    }

    fn build_packet(&mut self, body: &[u8]) -> Vec<u8> {
        let seq = self.sequence;
        self.sequence = self.sequence.wrapping_add(1);

        let len = body.len() as u16;
        let mut packet = Vec::with_capacity(6 + body.len());

        packet.push(MESSAGE_START);
        packet.push(seq);
        packet.push(((len >> 8) & 0xFF) as u8);
        packet.push((len & 0xFF) as u8);
        packet.push(TOKEN);
        packet.extend_from_slice(body);

        // Calculate checksum (XOR of all bytes except MESSAGE_START)
        let checksum = packet[1..].iter().fold(0u8, |acc, &b| acc ^ b);
        packet.push(checksum);

        packet
    }

    fn send_raw(&mut self, data: &[u8]) -> Result<(), FlashError> {
        self.port
            .write_all(data)
            .map_err(|e| FlashError::Communication(e.to_string()))?;
        self.port
            .flush()
            .map_err(|e| FlashError::Communication(e.to_string()))
    }

    fn receive_response(&mut self) -> Result<Vec<u8>, FlashError> {
        // Read header
        let mut header = [0u8; 5];
        self.port
            .read_exact(&mut header)
            .map_err(|e| FlashError::Communication(format!("Header read error: {}", e)))?;

        if header[0] != MESSAGE_START {
            return Err(FlashError::Communication(format!(
                "Invalid message start: {:02X}",
                header[0]
            )));
        }

        if header[4] != TOKEN {
            return Err(FlashError::Communication(format!(
                "Invalid token: {:02X}",
                header[4]
            )));
        }

        let len = ((header[2] as u16) << 8) | (header[3] as u16);

        // Read body + checksum
        let mut body = vec![0u8; len as usize + 1];
        self.port
            .read_exact(&mut body)
            .map_err(|e| FlashError::Communication(format!("Body read error: {}", e)))?;

        // Verify checksum
        let received_checksum = body.pop().unwrap();
        let mut calculated = header[1..].iter().fold(0u8, |acc, &b| acc ^ b);
        calculated = body.iter().fold(calculated, |acc, &b| acc ^ b);

        if received_checksum != calculated {
            return Err(FlashError::Communication(format!(
                "Checksum mismatch: expected {:02X}, got {:02X}",
                calculated, received_checksum
            )));
        }

        Ok(body)
    }
}
