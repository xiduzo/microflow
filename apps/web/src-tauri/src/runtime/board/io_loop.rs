//! Single-thread engine that owns `BoardConnection` exclusively. Drains the
//! `BoardCommand` channel between serial reads, mutates the connection, then
//! reads available bytes (decoded by the sans-IO codec) and emits pin-change /
//! I2C-reply events.
//!
//! The channel is the synchronization primitive — every op takes `&mut self`
//! on the connection (the codec caches pin state, and the port read borrows
//! mutably), so a shared `Mutex<BoardConnection>` would starve writers behind
//! blocking reads. This loop is the only place `&mut BoardConnection` exists.

use super::connection::BoardConnection;
use super::protocol::BoardCommand;
use super::BoardHandle;
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

        // 3. Read available bytes and decode. The codec buffers partial
        // messages and re-syncs past stray bytes internally, so the only
        // failure here is a real I/O error (port gone) — fatal to the loop.
        // Unhandled/unknown sysex frames are dropped silently by the codec
        // (formerly firmata-rs parse errors logged and ignored here).
        match conn.pump() {
            Ok(true) => {
                conn.detect_and_emit_changes();
                conn.drain_i2c_replies();
            }
            Ok(false) => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(e) => {
                log::warn!("Firmata reader: I/O error: {e}");
                handle.connected.store(false, std::sync::atomic::Ordering::Release);
                break;
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
                let _ = reply.send(conn.i2c_config(delay));
            }
            Ok(BoardCommand::I2cRead { address, size, reply }) => {
                let _ = reply.send(conn.i2c_read(address, size));
            }
            Ok(BoardCommand::I2cWrite { address, data, reply }) => {
                let _ = reply.send(conn.i2c_write(address, &data));
            }
            Ok(BoardCommand::I2cStopReading { address, reply }) => {
                let _ = reply.send(conn.i2c_stop_reading(address));
            }
            Err(mpsc::TryRecvError::Empty) => return DrainOutcome::Continue,
            Err(mpsc::TryRecvError::Disconnected) => {
                log::info!("Firmata reader: command channel closed, stopping");
                return DrainOutcome::Stop;
            }
        }
    }
}
