//! Hardware-side: `BoardHandle`, `BoardConnection`, the reader thread, and
//! the `BoardCommand` protocol that ferries write operations to it.
//!
//! The reader thread owns `BoardConnection` exclusively and processes commands
//! between read cycles, so component code never blocks on a serial port mutex.
//! Reader-thread state (callbacks, pin caches) lives on shared `Arc`s held by
//! both `BoardHandle` and `BoardConnection`, so it does not flow through the
//! channel.
//!
//! Re-exported via `super::base` for backwards compatibility.

mod connection;
mod protocol;

pub use connection::{
    BoardConnection, I2cReplyCallback, I2cReplyEvent, PinChangeCallback, PinChangeEvent,
    SerialPortWrapper,
};
pub use protocol::BoardCommand;

use connection::{I2cReplyCallbackSlot, PinChangeCallbackSlot};
use crate::error::{HardwareError, RuntimeError};
use dashmap::DashMap;
use firmata_rs::Firmata;
use std::sync::{Arc, RwLock};

/// Handle to the Firmata board for components to use.
///
/// The reader thread owns `BoardConnection` exclusively — no shared mutex on the hot path.
/// Pin-cache reads and callback installs go through shared `Arc`s instead of the
/// command channel; serial-port writes still flow through `send_command()` and are
/// processed between read cycles.
pub struct BoardHandle {
    /// Channel to send commands to the reader thread
    cmd_tx: std::sync::Mutex<Option<std::sync::mpsc::Sender<BoardCommand>>>,
    /// Whether the board is currently connected (cheap atomic check)
    connected: std::sync::atomic::AtomicBool,
    /// Flag to signal the reader thread to stop
    reader_running: std::sync::atomic::AtomicBool,
    /// Handle to the reader thread for joining on stop
    reader_handle: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Flag to cancel an in-progress tone on the reader thread.
    /// Checked inside the `tone()` spin-loop so `NoTone` can interrupt it.
    tone_cancel: std::sync::atomic::AtomicBool,
    /// Pin-value cache shared with the IO loop. Reader writes after Firmata
    /// reads; handle clears on flow update.
    pin_values: Arc<DashMap<u8, u16>>,
    /// Active-pin set shared with the IO loop. Handle inserts when a component
    /// registers a pin listener; reader iterates to decide which pins to scan.
    active_pins: Arc<DashMap<u8, ()>>,
    /// Pin-change callback slot. Reader reads once per emission; handle swaps
    /// when the runtime installs a new callback.
    pin_change_cb: PinChangeCallbackSlot,
    /// I2C-reply callback slot.
    i2c_reply_cb: I2cReplyCallbackSlot,
}

impl BoardHandle {
    #[must_use]
    pub fn new() -> Self {
        Self {
            cmd_tx: std::sync::Mutex::new(None),
            connected: std::sync::atomic::AtomicBool::new(false),
            reader_running: std::sync::atomic::AtomicBool::new(false),
            reader_handle: std::sync::Mutex::new(None),
            tone_cancel: std::sync::atomic::AtomicBool::new(false),
            pin_values: Arc::new(DashMap::new()),
            active_pins: Arc::new(DashMap::new()),
            pin_change_cb: Arc::new(RwLock::new(None)),
            i2c_reply_cb: Arc::new(RwLock::new(None)),
        }
    }

    /// Connect a board: build the `BoardConnection` with shared state and start
    /// the reader thread that takes exclusive ownership of it.
    pub fn connect_board(
        self: &Arc<Self>,
        board: firmata_rs::Board<SerialPortWrapper>,
        port_name: String,
    ) {
        let connection = BoardConnection::new(
            board,
            port_name,
            Arc::clone(&self.pin_values),
            Arc::clone(&self.active_pins),
            Arc::clone(&self.pin_change_cb),
            Arc::clone(&self.i2c_reply_cb),
        );
        self.connect(connection);
    }

    /// Spawn the IO loop with the supplied `BoardConnection`. Used by
    /// `connect_board` and tests.
    pub(crate) fn connect(self: &Arc<Self>, connection: BoardConnection) {
        self.stop_reader();

        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<BoardCommand>();
        *self.cmd_tx.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cmd_tx);
        self.connected.store(true, std::sync::atomic::Ordering::Release);
        self.reader_running.store(true, std::sync::atomic::Ordering::Release);

        let handle_clone = Arc::clone(self);
        let thread_handle = std::thread::spawn(move || {
            log::info!("Firmata reader thread started (exclusive ownership)");
            let mut conn = connection;

            loop {
                // 1. Drain all pending commands (non-blocking)
                loop {
                    match cmd_rx.try_recv() {
                        Ok(BoardCommand::Stop) => {
                            log::info!("Firmata reader thread: Stop received");
                            return;
                        }
                        Ok(BoardCommand::SetPinMode { pin, mode }) => {
                            let _ = conn.set_pin_mode(pin, mode);
                        }
                        Ok(BoardCommand::DigitalWrite { pin, value }) => {
                            let _ = conn.digital_write(pin, value);
                        }
                        Ok(BoardCommand::AnalogWrite { pin, value }) => {
                            let _ = conn.analog_write(pin, value);
                        }
                        Ok(BoardCommand::EnableAnalogReporting { pin }) => {
                            let _ = conn.enable_analog_reporting(pin);
                        }
                        Ok(BoardCommand::DisableAnalogReporting { pin }) => {
                            let _ = conn.disable_analog_reporting(pin);
                        }
                        Ok(BoardCommand::EnableDigitalReporting { pin }) => {
                            let _ = conn.set_reporting(pin, true);
                        }
                        Ok(BoardCommand::DisableDigitalReporting { pin }) => {
                            let _ = conn.set_reporting(pin, false);
                        }
                        Ok(BoardCommand::ResetAllReporting) => {
                            let _ = conn.reset_all_reporting();
                        }
                        Ok(BoardCommand::ShiftOut { data_pin, clock_pin, value }) => {
                            let _ = conn.shift_out(data_pin, clock_pin, value);
                        }
                        Ok(BoardCommand::Tone { pin, half_period_us, duration_ms }) => {
                            handle_clone.tone_cancel.store(false, std::sync::atomic::Ordering::Release);
                            let _ = conn.tone(pin, half_period_us, duration_ms, &handle_clone.tone_cancel);
                        }
                        Ok(BoardCommand::NoTone { pin }) => {
                            handle_clone.tone_cancel.store(true, std::sync::atomic::Ordering::Release);
                            let _ = conn.no_tone(pin);
                        }
                        Ok(BoardCommand::Sysex { command, data }) => {
                            let _ = conn.sysex_write(command, &data);
                        }
                        Ok(BoardCommand::I2cConfig { delay }) => {
                            let _ = conn.board.i2c_config(delay);
                        }
                        Ok(BoardCommand::I2cRead { address, size }) => {
                            let _ = conn.board.i2c_read(address, size);
                        }
                        Ok(BoardCommand::I2cWrite { address, data }) => {
                            let _ = conn.board.i2c_write(address, &data);
                        }
                        Ok(BoardCommand::I2cStopReading { address }) => {
                            // Send I2C stop reading mode (mode bits = 0b11)
                            use std::io::Write;
                            let mode_byte = 0b11 << 3;
                            let _ = conn.board.connection.write_all(&[
                                0xF0, 0x76, address as u8, mode_byte, 0xF7
                            ]);
                            let _ = conn.board.connection.flush();
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => break,
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                            log::info!("Firmata reader: command channel closed, stopping");
                            return;
                        }
                    }
                }

                // 2. Check stop flag
                if !handle_clone.reader_running.load(std::sync::atomic::Ordering::Acquire) {
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
                            // Real serial/transport error — disconnect.
                            log::warn!("Firmata reader: I/O error: {err_str}");
                            handle_clone.connected.store(false, std::sync::atomic::Ordering::Release);
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
        });

        *self.reader_handle.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(thread_handle);
    }

    pub fn disconnect(&self) {
        self.stop_reader();
        self.connected.store(false, std::sync::atomic::Ordering::Release);
        *self.cmd_tx.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::Acquire)
    }

    /// Send a command to the reader thread. Fire-and-forget, never blocks.
    /// Most callers should use the typed methods below instead of constructing
    /// `BoardCommand` variants by hand.
    pub fn send_command(&self, cmd: BoardCommand) -> Result<(), RuntimeError> {
        match self.cmd_tx.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref() {
            Some(tx) => tx.send(cmd).map_err(|_| RuntimeError::Hardware(HardwareError::FirmataCommunication("Board command channel closed".to_string()))),
            None => Err(RuntimeError::BoardNotConnected),
        }
    }

    // --- Typed pin-mode + write helpers -------------------------------------

    pub fn set_pin_mode(&self, pin: u8, mode: u8) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::SetPinMode { pin, mode })
    }

    pub fn digital_write(&self, pin: u8, value: bool) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::DigitalWrite { pin, value })
    }

    pub fn analog_write(&self, pin: u8, value: u16) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::AnalogWrite { pin, value })
    }

    // --- Reporting toggles --------------------------------------------------

    pub fn enable_analog_reporting(&self, pin: u8) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::EnableAnalogReporting { pin })
    }

    pub fn disable_analog_reporting(&self, pin: u8) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::DisableAnalogReporting { pin })
    }

    pub fn enable_digital_reporting(&self, pin: u8) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::EnableDigitalReporting { pin })
    }

    pub fn disable_digital_reporting(&self, pin: u8) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::DisableDigitalReporting { pin })
    }

    pub fn reset_all_reporting(&self) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::ResetAllReporting)
    }

    // --- Reader-thread state hooks (shared-state writes, no command) --------

    /// Install the pin-change callback. The IO loop reads this slot on every
    /// emission; clears the pin-value cache so fresh comparisons happen.
    pub fn set_pin_change_callback(&self, callback: Arc<PinChangeCallback>) -> Result<(), RuntimeError> {
        *self.pin_change_cb.write().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(callback);
        self.pin_values.clear();
        Ok(())
    }

    /// Install the I2C-reply callback.
    pub fn set_i2c_reply_callback(&self, callback: Arc<I2cReplyCallback>) -> Result<(), RuntimeError> {
        *self.i2c_reply_cb.write().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(callback);
        Ok(())
    }

    /// Clear cached pin values and active pin set (useful when flow changes).
    pub fn clear_pin_cache(&self) -> Result<(), RuntimeError> {
        self.pin_values.clear();
        self.active_pins.clear();
        Ok(())
    }

    /// Register a pin as active so the IO loop's `detect_and_emit_changes`
    /// includes it in its scan.
    pub fn register_active_pin(&self, pin: u8) -> Result<(), RuntimeError> {
        self.active_pins.insert(pin, ());
        Ok(())
    }

    // --- Bit-bang + tone + sysex --------------------------------------------

    pub fn shift_out(&self, data_pin: u8, clock_pin: u8, value: u8) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::ShiftOut { data_pin, clock_pin, value })
    }

    pub fn tone(&self, pin: u8, half_period_us: u32, duration_ms: u32) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::Tone { pin, half_period_us, duration_ms })
    }

    pub fn no_tone(&self, pin: u8) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::NoTone { pin })
    }

    pub fn sysex(&self, command: u8, data: Vec<u8>) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::Sysex { command, data })
    }

    // --- I2C ----------------------------------------------------------------

    pub fn i2c_config(&self, delay: i32) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::I2cConfig { delay })
    }

    pub fn i2c_read(&self, address: i32, size: i32) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::I2cRead { address, size })
    }

    pub fn i2c_write(&self, address: i32, data: Vec<u8>) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::I2cWrite { address, data })
    }

    pub fn i2c_stop_reading(&self, address: i32) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::I2cStopReading { address })
    }

    /// Stop the reader thread and wait for clean exit.
    pub fn stop_reader(&self) {
        self.reader_running.store(false, std::sync::atomic::Ordering::Release);
        if let Some(tx) = self.cmd_tx.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref() {
            let _ = tx.send(BoardCommand::Stop);
        }
        if let Some(handle) = self.reader_handle.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
            match handle.join() {
                Ok(()) => log::info!("Reader thread stopped cleanly"),
                Err(_) => log::warn!("Reader thread panicked during shutdown"),
            }
        }
    }
}

impl Default for BoardHandle {
    fn default() -> Self {
        Self::new()
    }
}
