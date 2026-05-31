//! Firmata protocol detection
//!
//! Detects if a board is running Firmata firmware and extracts
//! board capabilities (pins, modes, etc.)

use super::port_monitor::PortMonitor;
use super::types::{BoardState, PinInfo};
use crate::runtime::BoardHandle;
use microflow_core::firmata::FirmataClient;
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
/// Firmware-detection window: iterations × `PORT_TIMEOUT_MS` ≈ how long we wait
/// for the board to boot and answer (≈6s, matching `firmata-rs`'s old backoff).
const FIRMWARE_DETECT_ITERATIONS: usize = 60;
/// Re-send the firmware query every N iterations (≈ once per second) in case
/// the first query landed while the board was still resetting.
const FIRMWARE_REQUERY_EVERY: usize = 10;
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

    // Full detection - returns the open port + seeded protocol client
    let (info, port, client) = full_detect_with_board(port_name, baud_rate)?;

    // Hand the port + client to the BoardHandle, which builds the connection
    // with shared pin/cache/callback state and starts the reader thread.
    board_handle.connect_board(client, port, port_name.to_string());
    
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

/// Read whatever bytes are available and feed them to the codec. Returns the
/// byte count; a read timeout surfaces as the underlying `TimedOut` error so
/// callers can distinguish "no data yet (boot)" from a real I/O failure.
fn pump_into(port: &mut Box<dyn serialport::SerialPort>, client: &mut FirmataClient) -> std::io::Result<usize> {
    let mut buf = [0u8; 256];
    let n = port.read(&mut buf)?;
    client.feed(&buf[..n]);
    Ok(n)
}

/// True for a read that returned "no data within the timeout" — normal while
/// the Arduino is still booting after a DTR reset, not a failure.
fn is_no_data(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
}

/// Full Firmata detection with capability query - returns the open port and the
/// seeded protocol client (pin table + firmware filled in).
fn full_detect_with_board(
    port_name: &str,
    baud_rate: u32,
) -> Option<(FirmataInfo, Box<dyn serialport::SerialPort>, FirmataClient)> {
    log::info!("Full Firmata detection on {port_name} at {baud_rate} baud");

    let mut port = serialport::new(port_name, baud_rate)
        .timeout(Duration::from_millis(PORT_TIMEOUT_MS))
        .open()
        .ok()?;

    let mut client = FirmataClient::new();

    // Wait for the firmware report, re-querying periodically. Opening the port
    // often resets the board (DTR), so StandardFirmata can take ~2s to boot
    // before it answers — `firmata-rs::Board::new` papered over this with an
    // exponential backoff up to ~5s, so we must be just as patient or detection
    // races the boot and silently fails. Re-send the query roughly once a
    // second across the window; each `pump_into` blocks up to PORT_TIMEOUT_MS.
    for attempt in 0..FIRMWARE_DETECT_ITERATIONS {
        if attempt % FIRMWARE_REQUERY_EVERY == 0 {
            if port.write_all(&client.encode_query_firmware()).is_err() {
                return None;
            }
            let _ = port.flush();
        }
        match pump_into(&mut port, &mut client) {
            Ok(_) if !client.firmware_name.is_empty() => break,
            Ok(_) => {}
            Err(e) if is_no_data(&e) => continue,
            Err(e) => {
                log::warn!("Firmata firmware read error: {e}");
                return None; // Real I/O error — port gone or device error
            }
        }
    }

    if client.firmware_name.is_empty() {
        return None;
    }

    log::info!(
        "✓ Firmata: {} v{} on {}",
        client.firmware_name,
        client.firmware_version,
        port_name
    );

    // Query capabilities + analog mapping
    let _ = port.write_all(&client.encode_query_capabilities());
    let _ = port.flush();
    let _ = port.write_all(&client.encode_query_analog_mapping());
    let _ = port.flush();

    for _ in 0..CAPABILITY_READ_ITERATIONS {
        match pump_into(&mut port, &mut client) {
            Ok(_) => {}
            Err(e) if is_no_data(&e) => continue,
            Err(_) => break, // Real I/O error — stop early
        }
    }

    // Enable digital reporting for ports 0 and 1, matching what
    // `firmata-rs::Board::new` did on construction.
    let _ = port.write_all(&client.encode_report_digital(0, true));
    let _ = port.write_all(&client.encode_report_digital(1, true));
    let _ = port.flush();

    let pins = client
        .pins
        .iter()
        .enumerate()
        .map(|(index, pin)| PinInfo {
            pin: index,
            supported_modes: pin.modes.iter().map(|m| m.mode).collect(),
            analog_channel: if pin.analog { index as i32 } else { -1 },
        })
        .collect();

    log::info!("Found {} pins", client.pins.len());

    let info = FirmataInfo {
        firmware_name: client.firmware_name.clone(),
        firmware_version: client.firmware_version.clone(),
        pins,
    };

    Some((info, port, client))
}
