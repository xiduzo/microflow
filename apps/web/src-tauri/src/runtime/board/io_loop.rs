//! Single-thread engine that owns `BoardConnection` exclusively. Drains the
//! `BoardCommand` channel between Firmata reads, mutates the connection, then
//! reads one Firmata message and emits pin-change / I2C-reply events.
//!
//! The channel is the synchronization primitive — `firmata-rs` requires
//! `&mut self` for every op including reads, so a shared `Mutex<BoardConnection>`
//! would starve writers behind blocking reads. This loop is the only place
//! `&mut BoardConnection` exists.

use super::connection::BoardConnection;
use super::protocol::BoardCommand;
use super::BoardHandle;
use firmata_rs::Firmata;
use std::io::Write;
use std::sync::Arc;
use std::sync::mpsc;

/// Spawn the IO loop thread. Returns the `JoinHandle` so the handle can join
/// it on `stop_reader`.
pub(super) fn spawn(
    connection: BoardConnection,
    cmd_rx: mpsc::Receiver<BoardCommand>,
    handle: Arc<BoardHandle>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || run(connection, cmd_rx, &handle))
}

fn run(mut conn: BoardConnection, cmd_rx: mpsc::Receiver<BoardCommand>, handle: &Arc<BoardHandle>) {
    log::info!("Firmata reader thread started (exclusive ownership)");

    loop {
        // 1. Drain all pending commands (non-blocking)
        match drain_commands(&mut conn, &cmd_rx, handle) {
            DrainOutcome::Continue => {}
            DrainOutcome::Stop => return,
        }

        // 2. Check stop flag
        if !handle.reader_running.load(std::sync::atomic::Ordering::Acquire) {
            break;
        }

        // 3. Read one Firmata message
        match conn.board.read_and_decode() {
            Ok(_) => {
                conn.detect_and_emit_changes();
                conn.drain_i2c_replies();
            }
            Err(e) => {
                let err_str = format!("{e}");
                if err_str.contains("timed out") || err_str.contains("timeout") {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                } else if err_str.contains("I/O error") {
                    log::warn!("Firmata reader: I/O error: {err_str}");
                    handle.connected.store(false, std::sync::atomic::Ordering::Release);
                    break;
                } else {
                    // Protocol-level parse errors from firmata-rs:
                    // - "Unknown SysEx code: N" — unhandled SysEx (AccelStepper, string data, etc.)
                    // - "Message was too short." — truncated/unexpected SysEx payload
                    // - "Received a bad byte: N" — framing glitch after skipped SysEx
                    // These are non-fatal; the stream re-syncs on the next message boundary.
                    log::debug!("Firmata reader: skipping parse error: {err_str}");
                }
            }
        }
    }

    log::info!("Firmata reader thread stopped");
}

enum DrainOutcome {
    Continue,
    Stop,
}

fn drain_commands(
    conn: &mut BoardConnection,
    cmd_rx: &mpsc::Receiver<BoardCommand>,
    handle: &Arc<BoardHandle>,
) -> DrainOutcome {
    use crate::error::HardwareError;

    // Map firmata-rs's connection-write outcome (no return value) to a Result.
    let i2c_stop_reading = |conn: &mut BoardConnection, address: i32| -> Result<(), HardwareError> {
        let mode_byte = 0b11 << 3;
        conn.board
            .connection
            .write_all(&[0xF0, 0x76, address as u8, mode_byte, 0xF7])
            .and_then(|()| conn.board.connection.flush())
            .map_err(|e| HardwareError::FirmataCommunication(e.to_string()))
    };

    loop {
        match cmd_rx.try_recv() {
            Ok(BoardCommand::Stop) => {
                log::info!("Firmata reader thread: Stop received");
                return DrainOutcome::Stop;
            }
            Ok(BoardCommand::SetPinMode { pin, mode, reply }) => {
                let _ = reply.send(conn.set_pin_mode(pin, mode));
            }
            Ok(BoardCommand::DigitalWrite { pin, value, reply }) => {
                let _ = reply.send(conn.digital_write(pin, value));
            }
            Ok(BoardCommand::AnalogWrite { pin, value, reply }) => {
                let _ = reply.send(conn.analog_write(pin, value));
            }
            Ok(BoardCommand::EnableAnalogReporting { pin, reply }) => {
                let _ = reply.send(conn.enable_analog_reporting(pin));
            }
            Ok(BoardCommand::DisableAnalogReporting { pin, reply }) => {
                let _ = reply.send(conn.disable_analog_reporting(pin));
            }
            Ok(BoardCommand::EnableDigitalReporting { pin, reply }) => {
                let _ = reply.send(conn.set_reporting(pin, true));
            }
            Ok(BoardCommand::DisableDigitalReporting { pin, reply }) => {
                let _ = reply.send(conn.set_reporting(pin, false));
            }
            Ok(BoardCommand::ResetAllReporting { reply }) => {
                let _ = reply.send(conn.reset_all_reporting());
            }
            Ok(BoardCommand::ShiftOut { data_pin, clock_pin, value, reply }) => {
                let _ = reply.send(conn.shift_out(data_pin, clock_pin, value));
            }
            Ok(BoardCommand::Tone { pin, half_period_us, duration_ms, reply }) => {
                handle.tone_cancel.store(false, std::sync::atomic::Ordering::Release);
                let outcome = conn.tone(pin, half_period_us, duration_ms, &handle.tone_cancel);
                let _ = reply.send(outcome);
            }
            Ok(BoardCommand::NoTone { pin, reply }) => {
                handle.tone_cancel.store(true, std::sync::atomic::Ordering::Release);
                let _ = reply.send(conn.no_tone(pin));
            }
            Ok(BoardCommand::Sysex { command, data, reply }) => {
                let _ = reply.send(conn.sysex_write(command, &data));
            }
            Ok(BoardCommand::I2cConfig { delay, reply }) => {
                let outcome = conn
                    .board
                    .i2c_config(delay)
                    .map_err(|e| HardwareError::FirmataCommunication(format!("{e:?}")));
                let _ = reply.send(outcome);
            }
            Ok(BoardCommand::I2cRead { address, size, reply }) => {
                let outcome = conn
                    .board
                    .i2c_read(address, size)
                    .map_err(|e| HardwareError::FirmataCommunication(format!("{e:?}")));
                let _ = reply.send(outcome);
            }
            Ok(BoardCommand::I2cWrite { address, data, reply }) => {
                let outcome = conn
                    .board
                    .i2c_write(address, &data)
                    .map_err(|e| HardwareError::FirmataCommunication(format!("{e:?}")));
                let _ = reply.send(outcome);
            }
            Ok(BoardCommand::I2cStopReading { address, reply }) => {
                let _ = reply.send(i2c_stop_reading(conn, address));
            }
            Err(mpsc::TryRecvError::Empty) => return DrainOutcome::Continue,
            Err(mpsc::TryRecvError::Disconnected) => {
                log::info!("Firmata reader: command channel closed, stopping");
                return DrainOutcome::Stop;
            }
        }
    }
}
