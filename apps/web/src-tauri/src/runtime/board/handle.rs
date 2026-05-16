//! Public flow-runtime seam to the connected Firmata board. Hardware
//! `Component` impls receive `Arc<BoardHandle>` and call typed methods that
//! either enqueue a `BoardCommand` on the **Board IO Loop**'s channel
//! (Firmata wire ops, returning a [`CommandReceipt`]) or write directly to
//! shared state (cache + callback installs, returning `Result`). The handle
//! never blocks on the serial port.

use super::connection::{
    BoardConnection, I2cReplyCallback, I2cReplyCallbackSlot, PinChangeCallback,
    PinChangeCallbackSlot, SerialPortWrapper,
};
use super::io_loop;
use super::protocol::BoardCommand;
use super::receipt::{CommandReceipt, PinSnapshot};
use crate::error::RuntimeError;
use dashmap::DashMap;
use std::sync::{Arc, RwLock};
use std::time::Instant;
use tokio::sync::oneshot;

/// Handle to the Firmata board for components to use.
///
/// The reader thread owns `BoardConnection` exclusively — no shared mutex on the hot path.
/// Pin-cache reads and callback installs go through shared `Arc`s instead of the
/// command channel; serial-port writes flow through typed methods that return a
/// [`CommandReceipt`] resolved by the IO loop.
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
    /// reads; handle clears on flow update. Each entry pairs the observed value
    /// with the `Instant` at which the IO loop captured it, so `pin_snapshot`
    /// can expose honest staleness.
    pin_values: Arc<DashMap<u8, (u16, Instant)>>,
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

    /// Enqueue a wire command on the reader thread's channel and return its
    /// [`CommandReceipt`]. If the channel is closed or no IO loop is running,
    /// the receipt resolves to `Err(HardwareError::Disconnected)` because the
    /// command's reply sender drops with the unsent command.
    fn send_command(
        &self,
        cmd: BoardCommand,
        rx: oneshot::Receiver<Result<(), crate::error::HardwareError>>,
    ) -> CommandReceipt {
        if let Some(tx) = self
            .cmd_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            // If the IO loop has dropped its receiver, send returns Err(SendError(cmd));
            // cmd contains the reply sender, which drops here → receipt resolves to
            // Err(Disconnected). No explicit branching needed.
            let _ = tx.send(cmd);
        }
        // If cmd_tx is None, `cmd` is dropped at end of scope → same outcome path.
        CommandReceipt::new(rx)
    }

    // --- Typed pin-mode + write helpers -------------------------------------

    pub fn set_pin_mode(&self, pin: u8, mode: u8) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::SetPinMode { pin, mode, reply }, rx)
    }

    pub fn digital_write(&self, pin: u8, value: bool) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::DigitalWrite { pin, value, reply }, rx)
    }

    pub fn analog_write(&self, pin: u8, value: u16) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::AnalogWrite { pin, value, reply }, rx)
    }

    // --- Reporting toggles --------------------------------------------------

    pub fn enable_analog_reporting(&self, pin: u8) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::EnableAnalogReporting { pin, reply }, rx)
    }

    pub fn disable_analog_reporting(&self, pin: u8) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::DisableAnalogReporting { pin, reply }, rx)
    }

    pub fn enable_digital_reporting(&self, pin: u8) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::EnableDigitalReporting { pin, reply }, rx)
    }

    pub fn disable_digital_reporting(&self, pin: u8) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::DisableDigitalReporting { pin, reply }, rx)
    }

    pub fn reset_all_reporting(&self) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::ResetAllReporting { reply }, rx)
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

    /// Stop the IO loop's `detect_and_emit_changes` from scanning this pin.
    /// Paired with `register_active_pin` when a flow update removes a component.
    pub fn unregister_active_pin(&self, pin: u8) {
        self.active_pins.remove(&pin);
    }

    /// Point-in-time read of a pin's last cached value. Returns `None` if the
    /// IO loop has never observed the pin. The snapshot's `board_connected`
    /// field reflects connection state at read time, not at capture time —
    /// callers can distinguish "fresh, board live" from "last known, board gone".
    ///
    /// Live reads (edge components reacting to changes) flow through the
    /// `on_pin_change` callback path; this method is for snapshot queries.
    pub fn pin_snapshot(&self, pin: u8) -> Option<PinSnapshot> {
        self.pin_values.get(&pin).map(|entry| {
            let (value, captured_at) = *entry;
            PinSnapshot {
                value,
                captured_at,
                board_connected: self.is_connected(),
            }
        })
    }

    // --- Bit-bang + tone + sysex --------------------------------------------

    pub fn shift_out(&self, data_pin: u8, clock_pin: u8, value: u8) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(
            BoardCommand::ShiftOut { data_pin, clock_pin, value, reply },
            rx,
        )
    }

    pub fn tone(&self, pin: u8, half_period_us: u32, duration_ms: u32) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(
            BoardCommand::Tone { pin, half_period_us, duration_ms, reply },
            rx,
        )
    }

    pub fn no_tone(&self, pin: u8) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::NoTone { pin, reply }, rx)
    }

    pub fn sysex(&self, command: u8, data: Vec<u8>) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::Sysex { command, data, reply }, rx)
    }

    // --- I2C ----------------------------------------------------------------

    pub fn i2c_config(&self, delay: i32) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::I2cConfig { delay, reply }, rx)
    }

    pub fn i2c_read(&self, address: i32, size: i32) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::I2cRead { address, size, reply }, rx)
    }

    pub fn i2c_write(&self, address: i32, data: Vec<u8>) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::I2cWrite { address, data, reply }, rx)
    }

    pub fn i2c_stop_reading(&self, address: i32) -> CommandReceipt {
        let (reply, rx) = oneshot::channel();
        self.send_command(BoardCommand::I2cStopReading { address, reply }, rx)
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

impl BoardHandle {
    /// Construct a `BoardHandle` paired with a [`super::TestIoLoop`] for tests.
    /// The handle is in "connected" state but no serial port is opened — wire
    /// ops flow through the test IO loop, which records each `BoardCommand`
    /// and lets the test script the outcome.
    pub fn test_pair() -> (Arc<Self>, super::TestIoLoop) {
        let handle = Arc::new(Self::new());
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<BoardCommand>();
        *handle
            .cmd_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cmd_tx);
        handle
            .connected
            .store(true, std::sync::atomic::Ordering::Release);
        let io_loop = super::TestIoLoop::new(cmd_rx, Arc::clone(&handle));
        (handle, io_loop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::HardwareError;

    #[test]
    fn write_when_not_connected_resolves_to_disconnected() {
        let handle = BoardHandle::new();
        let receipt = handle.digital_write(13, true);
        assert!(matches!(receipt.wait(), Err(HardwareError::Disconnected)));
    }

    #[test]
    fn pin_snapshot_returns_none_when_never_captured() {
        let handle = BoardHandle::new();
        assert!(handle.pin_snapshot(13).is_none());
    }
}
