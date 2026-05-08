//! Public flow-runtime seam to the connected Firmata board. Hardware
//! `Component` impls receive `Arc<BoardHandle>` and call typed methods that
//! either enqueue a `BoardCommand` on the **Board IO Loop**'s channel
//! (Firmata wire ops) or write directly to shared state (cache + callback
//! installs). The handle never blocks on the serial port.

use super::connection::{
    BoardConnection, I2cReplyCallback, I2cReplyCallbackSlot, PinChangeCallback,
    PinChangeCallbackSlot, SerialPortWrapper,
};
use super::io_loop;
use super::protocol::BoardCommand;
use crate::error::{HardwareError, RuntimeError};
use dashmap::DashMap;
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
    /// Whether the board is currently connected (cheap atomic check).
    /// `pub(super)` so the IO loop can flip it on I/O failure.
    pub(super) connected: std::sync::atomic::AtomicBool,
    /// Flag to signal the reader thread to stop. Read by the IO loop.
    pub(super) reader_running: std::sync::atomic::AtomicBool,
    /// Handle to the reader thread for joining on stop
    reader_handle: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Flag to cancel an in-progress tone on the reader thread.
    /// Checked inside the `tone()` spin-loop so `NoTone` can interrupt it.
    pub(super) tone_cancel: std::sync::atomic::AtomicBool,
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

        let thread_handle = io_loop::spawn(connection, cmd_rx, Arc::clone(self));

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

    /// Enqueue a command on the reader thread's channel. Fire-and-forget,
    /// never blocks. Internal: callers use the typed methods below.
    pub(super) fn send_command(&self, cmd: BoardCommand) -> Result<(), RuntimeError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_command_returns_err_when_not_connected() {
        let handle = BoardHandle::new();
        let result = handle.send_command(BoardCommand::ResetAllReporting);
        assert!(result.is_err(), "send_command must fail when not connected");
        assert!(result.unwrap_err().to_string().contains("not connected"));
    }
}
