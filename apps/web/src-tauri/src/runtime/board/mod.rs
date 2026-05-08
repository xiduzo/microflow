//! Hardware-side: `BoardHandle`, `BoardConnection`, the reader thread, and
//! the `BoardCommand` protocol that ferries write operations to it.
//!
//! The reader thread owns `BoardConnection` exclusively and processes commands
//! between read cycles, so component code never blocks on a serial port mutex.
//! Re-exported via `super::base` for backwards compatibility.

mod connection;

pub use connection::{
    BoardConnection, I2cReplyCallback, I2cReplyEvent, PinChangeCallback, PinChangeEvent,
    SerialPortWrapper,
};

use crate::error::{HardwareError, RuntimeError};
use firmata_rs::Firmata;
use std::sync::Arc;

/// Handle to the Firmata board for components to use.
///
/// The reader thread owns `BoardConnection` exclusively — no shared mutex on the hot path.
/// All write operations are sent via `send_command()` and processed between read cycles.
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
        }
    }

    /// Connect a board and immediately start the reader thread.
    /// The reader thread takes exclusive ownership of `connection`.
    pub fn connect(self: &Arc<Self>, connection: BoardConnection) {
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
                        Ok(BoardCommand::SetPinChangeCallback { callback }) => {
                            conn.set_pin_change_callback(callback);
                        }
                        Ok(BoardCommand::SetI2cReplyCallback { callback }) => {
                            conn.i2c_reply_callback = Some(callback);
                        }
                        Ok(BoardCommand::ClearPinCache) => {
                            conn.clear_pin_cache();
                        }
                        Ok(BoardCommand::RegisterActivePin { pin }) => {
                            conn.active_pins.insert(pin);
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

    // --- Reader-thread state hooks ------------------------------------------

    pub fn set_pin_change_callback(&self, callback: Arc<PinChangeCallback>) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::SetPinChangeCallback { callback })
    }

    pub fn set_i2c_reply_callback(&self, callback: Arc<I2cReplyCallback>) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::SetI2cReplyCallback { callback })
    }

    pub fn clear_pin_cache(&self) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::ClearPinCache)
    }

    pub fn register_active_pin(&self, pin: u8) -> Result<(), RuntimeError> {
        self.send_command(BoardCommand::RegisterActivePin { pin })
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

/// Commands sent to the reader thread for board operations.
/// The reader thread owns `BoardConnection` exclusively and processes
/// these between read cycles — no mutex contention on the hot path.
pub enum BoardCommand {
    SetPinMode { pin: u8, mode: u8 },
    DigitalWrite { pin: u8, value: bool },
    AnalogWrite { pin: u8, value: u16 },
    EnableAnalogReporting { pin: u8 },
    DisableAnalogReporting { pin: u8 },
    EnableDigitalReporting { pin: u8 },
    DisableDigitalReporting { pin: u8 },
    ResetAllReporting,
    SetPinChangeCallback { callback: Arc<PinChangeCallback> },
    /// Set the callback for I2C reply events.
    SetI2cReplyCallback { callback: Arc<I2cReplyCallback> },
    ClearPinCache,
    /// Register a pin as active so `detect_and_emit_changes` checks it.
    RegisterActivePin { pin: u8 },
    /// Shift out a byte MSB-first on `data_pin`, clocking `clock_pin`.
    /// Equivalent to Arduino's shiftOut(dataPin, clockPin, MSBFIRST, value).
    /// Performed atomically on the reader thread for correct timing.
    ShiftOut { data_pin: u8, clock_pin: u8, value: u8 },
    /// Play a tone by toggling a pin at the given half-period (µs) for duration (ms).
    /// Executed directly on the reader thread for tight timing (no channel overhead).
    Tone { pin: u8, half_period_us: u32, duration_ms: u32 },
    /// Stop tone and drive pin low.
    NoTone { pin: u8 },
    /// Send a raw sysex message (`START_SYSEX` + command + data + `END_SYSEX`).
    Sysex { command: u8, data: Vec<u8> },
    /// Configure the I2C bus delay (microseconds). Must be sent before any I2C operations.
    I2cConfig { delay: i32 },
    /// Read `size` bytes from I2C device at `address`. Uses read-once mode.
    I2cRead { address: i32, size: i32 },
    /// Write `data` bytes to I2C device at `address`.
    I2cWrite { address: i32, data: Vec<u8> },
    /// Stop continuous I2C reading for `address`.
    I2cStopReading { address: i32 },
    Stop,
}
