//! Firmata protocol detection
//!
//! Detects if a board is running Firmata firmware and extracts
//! board capabilities (pins, modes, etc.)

use super::port_monitor::PortMonitor;
use super::types::{BoardState, PinInfo};
use crate::runtime::{BoardHandle, SerialPortWrapper};
use firmata_rs::{Board, Firmata};
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

// Firmata protocol constants
const REPORT_VERSION: u8 = 0xF9;
const START_SYSEX: u8 = 0xF0;
const END_SYSEX: u8 = 0xF7;
const REPORT_FIRMWARE: u8 = 0x79;

// Timing constants
const PORT_TIMEOUT_MS: u64 = 100;
const FIRMWARE_READ_ITERATIONS: usize = 5;
const CAPABILITY_READ_ITERATIONS: usize = 10;

/// Detect Firmata on a port and connect directly to the provided `BoardHandle`.
/// Returns `BoardState` if successful, and the board connection is stored in the handle.
pub fn detect_and_connect(port_name: &str, board_handle: &Arc<BoardHandle>) -> Option<BoardState> {
    if PortMonitor::should_skip_firmata_test(port_name) {
        return None;
    }

    log::info!("Starting Firmata detection on: {port_name}");

    // Quick probe to find working baud rate
    let baud_rate = find_firmata_baud(port_name)?;

    log::info!(
        "Quick probe found Firmata at {baud_rate} baud, doing full detection"
    );

    // Full detection with firmata-rs - returns the board connection
    let (info, board) = full_detect_with_board(port_name, baud_rate)?;

    // Hand the firmata board to the BoardHandle, which builds the connection
    // with shared pin/cache/callback state and starts the reader thread.
    board_handle.connect_board(board, port_name.to_string());
    
    log::info!("Board connected and stored in BoardHandle");

    Some(BoardState::Connected {
        port: port_name.to_string(),
        firmware_name: info.firmware_name,
        firmware_version: info.firmware_version,
        pins: info.pins,
    })
}

/// Result of successful Firmata detection
struct FirmataInfo {
    firmware_name: String,
    firmware_version: String,
    pins: Vec<PinInfo>,
}

/// Find which baud rate Firmata is running at
fn find_firmata_baud(port_name: &str) -> Option<u32> {
    for &baud_rate in &[57600u32, 115200] {
        if quick_probe(port_name, baud_rate) {
            return Some(baud_rate);
        }
    }
    log::info!("Firmata not detected on: {port_name}");
    None
}

/// Quick probe to check if Firmata is running (without firmata-rs)
fn quick_probe(port_name: &str, baud_rate: u32) -> bool {
    log::info!("Quick probe on {port_name} at {baud_rate} baud");

    let mut port = match serialport::new(port_name, baud_rate)
        .timeout(Duration::from_secs(1))
        .open()
    {
        Ok(p) => p,
        Err(e) => {
            log::info!("Failed to open port: {e}");
            return false;
        }
    };

    // Reset board via DTR/RTS toggle
    reset_board(&mut port);

    // Clear pending data
    let _ = port.clear(serialport::ClearBuffer::All);
    std::thread::sleep(Duration::from_millis(100));

    // Try multiple times (CH340 can be slow)
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(200));
            let _ = port.clear(serialport::ClearBuffer::Input);
        }

        // Send version request
        if port.write_all(&[REPORT_VERSION]).is_err() {
            continue;
        }
        let _ = port.flush();

        // Send firmware query
        if port.write_all(&[START_SYSEX, REPORT_FIRMWARE, END_SYSEX]).is_err() {
            continue;
        }
        let _ = port.flush();

        std::thread::sleep(Duration::from_millis(300));

        // Check response
        let mut buf = [0u8; 128];
        if let Ok(n) = port.read(&mut buf) {
            if n > 0 && has_firmata_markers(&buf[..n]) {
                return true;
            }
        }
    }

    false
}

/// Reset board by toggling DTR/RTS
fn reset_board(port: &mut Box<dyn serialport::SerialPort>) {
    let _ = port.write_data_terminal_ready(false);
    let _ = port.write_request_to_send(false);
    std::thread::sleep(Duration::from_millis(250));
    let _ = port.write_data_terminal_ready(true);
    let _ = port.write_request_to_send(true);
    std::thread::sleep(Duration::from_millis(1500));
}

/// Check buffer for Firmata protocol markers
fn has_firmata_markers(buf: &[u8]) -> bool {
    for i in 0..buf.len() {
        // Version response: 0xF9 major minor
        if buf[i] == REPORT_VERSION && i + 2 < buf.len() {
            log::info!("Firmata version: {}.{}", buf[i + 1], buf[i + 2]);
            return true;
        }
        // Firmware sysex: 0xF0 0x79 ...
        if buf[i] == START_SYSEX && i + 1 < buf.len() && buf[i + 1] == REPORT_FIRMWARE {
            log::info!("Firmata firmware sysex detected");
            return true;
        }
    }
    false
}

/// Full Firmata detection with capability query - returns the Board instance
fn full_detect_with_board(port_name: &str, baud_rate: u32) -> Option<(FirmataInfo, Board<SerialPortWrapper>)> {
    log::info!("Full Firmata detection on {port_name} at {baud_rate} baud");

    let port = serialport::new(port_name, baud_rate)
        .timeout(Duration::from_millis(PORT_TIMEOUT_MS))
        .open()
        .ok()?;

    let wrapper = SerialPortWrapper::new(port);
    let mut board = Board::new(Box::new(wrapper)).ok()?;

    // Query firmware
    board.query_firmware().ok()?;

    // Read firmware response — treat timeouts as "no data yet" and keep retrying.
    // Only abort on real I/O errors (e.g., port disappeared) to avoid false negatives
    // when the Arduino is still booting after a DTR reset.
    for _ in 0..FIRMWARE_READ_ITERATIONS {
        match board.read_and_decode() {
            Ok(_) if !board.firmware_name.is_empty() => break,
            Err(e) => {
                let err_str = format!("{e}");
                if err_str.contains("timed out") || err_str.contains("timeout") {
                    continue; // Normal during boot — try again
                }
                log::warn!("Firmata firmware read error: {err_str}");
                return None; // Real I/O error — port gone or device error
            }
            _ => {}
        }
    }

    if board.firmware_name.is_empty() {
        return None;
    }

    log::info!(
        "✓ Firmata: {} v{} on {}",
        board.firmware_name,
        board.firmware_version,
        port_name
    );

    // Query capabilities
    let _ = board.query_capabilities();
    let _ = board.query_analog_mapping();

    for _ in 0..CAPABILITY_READ_ITERATIONS {
        match board.read_and_decode() {
            Ok(_) => {}
            Err(e) => {
                let err_str = format!("{e}");
                if err_str.contains("timed out") || err_str.contains("timeout") {
                    continue; // Timeout is normal — keep draining
                }
                break; // Real I/O error — stop early
            }
        }
    }

    let pins = board
        .pins()
        .iter()
        .enumerate()
        .map(|(index, pin)| PinInfo {
            pin: index,
            supported_modes: pin.modes.iter().map(|m| m.mode).collect(),
            analog_channel: if pin.analog { index as i32 } else { -1 },
        })
        .collect();

    log::info!("Found {} pins", board.pins().len());

    let info = FirmataInfo {
        firmware_name: board.firmware_name.clone(),
        firmware_version: board.firmware_version.clone(),
        pins,
    };

    Some((info, board))
}
