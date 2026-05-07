//! LED Matrix Component - Output (MAX7219)
//!
//! Drives a MAX7219-based LED matrix via bit-banged SPI.
//! Uses `ShiftOut` board command for atomic byte transfers matching
//! Johnny-Five's `LedControl.send()` approach.
//!
//! ## Hardening
//!
//! - CS line is always restored HIGH on SPI transaction failure to prevent
//!   leaving the MAX7219 in a corrupted mid-transaction state.
//! - Board connectivity is checked before every operation; stale board
//!   references are dropped eagerly.
//! - `reinitialize()` allows recovery from corrupted MAX7219 state without
//!   destroying the component.
//! - Binary shape parsing logs warnings on malformed data instead of
//!   silently producing zeros.

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// MAX7219 registers
const REG_DECODE_MODE: u8 = 0x09;
const REG_INTENSITY: u8 = 0x0A;
const REG_SCAN_LIMIT: u8 = 0x0B;
const REG_SHUTDOWN: u8 = 0x0C;
const REG_DISPLAY_TEST: u8 = 0x0F;

/// Maximum number of SPI transaction retries before giving up.
const MAX_RETRIES: u8 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatrixPins {
    #[serde(default = "default_data", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub data: u8,
    #[serde(default = "default_clock", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub clock: u8,
    #[serde(default = "default_cs", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub cs: u8,
}

fn default_data() -> u8 { 2 }
fn default_clock() -> u8 { 3 }
fn default_cs() -> u8 { 4 }

impl Default for MatrixPins {
    fn default() -> Self {
        Self { data: default_data(), clock: default_clock(), cs: default_cs() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MatrixConfig {
    #[serde(default)]
    pub pins: MatrixPins,
    #[serde(default = "default_devices")]
    pub devices: u8,
    #[serde(default = "default_dims")]
    pub dims: String,
    #[serde(default)]
    pub shapes: Vec<Vec<String>>,
}

fn default_devices() -> u8 { 1 }
fn default_dims() -> String { "8x8".to_string() }

pub struct Matrix {
    base: ComponentBase,
    config: MatrixConfig,
    board: Option<Arc<BoardHandle>>,
    current_shape_index: usize,
}

impl Matrix {
    #[must_use]
    pub fn new(id: String, config: MatrixConfig) -> Self {
        log::info!(
            "Matrix::new id={id} pins=(data={}, clock={}, cs={}) devices={} shapes={}",
            config.pins.data, config.pins.clock, config.pins.cs,
            config.devices, config.shapes.len()
        );
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            board: None,
            current_shape_index: 0,
        }
    }

    /// Get a live board reference, or drop the stale one and return an error.
    /// This is the single gate for all board operations — if the board
    /// disconnected since we last checked, we find out here.
    fn live_board(&mut self) -> Result<Arc<BoardHandle>, crate::error::RuntimeError> {
        if let Some(board) = &self.board {
            if board.is_connected() {
                return Ok(Arc::clone(board));
            }
            // Board disconnected under us — drop the stale reference
            log::warn!("Matrix {}: board disconnected, dropping stale handle", self.base.id);
            self.board = None;
        }
        Err(crate::error::RuntimeError::BoardNotConnected)
    }

    /// Send a register+data command to a specific device in the chain.
    ///
    /// CS is always restored HIGH on failure to prevent leaving the MAX7219
    /// in a corrupted mid-transaction state. This is the most critical
    /// hardening — a stuck-low CS line makes every subsequent transaction
    /// garbage and the matrix appears "dead".
    fn send(&self, board: &Arc<BoardHandle>, addr: u8, opcode: u8, data: u8) -> Result<(), crate::error::RuntimeError> {
        if (addr as usize) >= self.config.devices as usize {
            return Ok(());
        }

        let offset = (addr as usize) * 2;
        let max_bytes = (self.config.devices as usize) * 2;
        let mut spi_data = vec![0u8; max_bytes];
        spi_data[offset + 1] = opcode;
        spi_data[offset] = data;

        // Pull CS low to start transaction
        board.send_command(BoardCommand::DigitalWrite {
            pin: self.config.pins.cs,
            value: false,
        })?;

        // Shift out all bytes; if any fail, restore CS HIGH before returning
        let shift_result = (|| -> Result<(), crate::error::RuntimeError> {
            for j in (0..max_bytes).rev() {
                board.send_command(BoardCommand::ShiftOut {
                    data_pin: self.config.pins.data,
                    clock_pin: self.config.pins.clock,
                    value: spi_data[j],
                })?;
            }
            Ok(())
        })();

        // ALWAYS restore CS HIGH — this is the critical safety net.
        // Even if shift_out failed mid-byte, the MAX7219 will see the
        // rising edge of CS and latch whatever partial data it received,
        // then be ready for the next clean transaction.
        let cs_result = board.send_command(BoardCommand::DigitalWrite {
            pin: self.config.pins.cs,
            value: true,
        });

        // Propagate the first error (shift failure takes priority)
        shift_result?;
        cs_result
    }

    /// Send a command to all devices.
    fn send_to_all(&self, board: &Arc<BoardHandle>, opcode: u8, data: u8) -> Result<(), crate::error::RuntimeError> {
        for device in 0..self.config.devices {
            self.send(board, device, opcode, data)?;
        }
        Ok(())
    }

    /// Initialize the MAX7219 chip(s).
    /// Safe to call multiple times — used both at startup and for recovery.
    fn init_max7219(&self, board: &Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        log::info!("Matrix {}: initializing MAX7219 (pins: data={}, clock={}, cs={})",
            self.base.id, self.config.pins.data, self.config.pins.clock, self.config.pins.cs);

        // Force CS HIGH before init to reset any stuck SPI state from a
        // previous partial transaction (e.g. after a crash or hot-reload)
        board.send_command(BoardCommand::DigitalWrite {
            pin: self.config.pins.cs,
            value: true,
        })?;

        for device in 0..self.config.devices {
            // Match J5 LedControl init order exactly — wrong order causes all LEDs to stay lit
            self.send(board, device, REG_DECODE_MODE, 0)?;
            self.send(board, device, REG_INTENSITY, 3)?;
            self.send(board, device, REG_SCAN_LIMIT, 7)?;
            self.send(board, device, REG_SHUTDOWN, 1)?;
            self.send(board, device, REG_DISPLAY_TEST, 0)?;
            for row in 1..=8 {
                self.send(board, device, row, 0)?;
            }
            // J5 calls on() after clear, re-asserting normal operation
            self.send(board, device, REG_SHUTDOWN, 1)?;
        }
        log::info!("Matrix {}: MAX7219 initialized", self.base.id);
        Ok(())
    }

    /// Attempt a full re-initialization of the MAX7219 and redisplay the
    /// current shape. Called when a transaction fails to recover from
    /// corrupted chip state.
    fn reinitialize(&mut self) -> Result<(), crate::error::RuntimeError> {
        let board = self.live_board()?;
        log::warn!("Matrix {}: reinitializing MAX7219 after failure", self.base.id);
        self.init_max7219(&board)?;
        if !self.config.shapes.is_empty() {
            let shape = self.config.shapes[self.current_shape_index].clone();
            self.display_shape(&board, &shape)?;
        }
        Ok(())
    }

    /// Display a shape on the matrix.
    fn display_shape(&self, board: &Arc<BoardHandle>, shape: &[String]) -> Result<(), crate::error::RuntimeError> {
        for device in 0..self.config.devices {
            for row in 0..8u8 {
                let row_idx = row as usize;
                let byte = if row_idx < shape.len() {
                    let row_str = &shape[row_idx];
                    let start = (device as usize) * 8;
                    let end = start + 8;
                    if start < row_str.len() {
                        let slice_end = end.min(row_str.len());
                        let slice = &row_str[start..slice_end];
                        match u8::from_str_radix(slice, 2) {
                            Ok(v) => v,
                            Err(e) => {
                                log::warn!(
                                    "Matrix {}: bad binary in row {} device {}: {:?} ({})",
                                    self.base.id, row, device, slice, e
                                );
                                0
                            }
                        }
                    } else {
                        0
                    }
                } else {
                    0
                };
                log::debug!("Matrix {}: row {} device {} = 0x{:02X} (0b{:08b})",
                    self.base.id, row, device, byte, byte);
                self.send(board, device, row + 1, byte)?;
            }
        }
        Ok(())
    }

    fn set_shape(&mut self, index: usize) -> Result<(), crate::error::RuntimeError> {
        if self.config.shapes.is_empty() {
            log::warn!("Matrix {}: no shapes configured", self.base.id);
            return Ok(());
        }
        let clamped = index.min(self.config.shapes.len() - 1);
        self.current_shape_index = clamped;

        let board = self.live_board()?;
        let shape = self.config.shapes[clamped].clone();

        // Try to display; on failure, reinitialize and retry up to MAX_RETRIES
        let mut last_err = None;
        for attempt in 0..=MAX_RETRIES {
            match self.display_shape(&board, &shape) {
                Ok(()) => {
                    if attempt > 0 {
                        log::info!("Matrix {}: display succeeded on retry {attempt}", self.base.id);
                    }
                    last_err = None;
                    break;
                }
                Err(e) => {
                    log::warn!(
                        "Matrix {}: display_shape failed (attempt {}/{}): {}",
                        self.base.id, attempt + 1, MAX_RETRIES + 1, e
                    );
                    last_err = Some(e);
                    if attempt < MAX_RETRIES {
                        // Re-init the chip to recover from corrupted SPI state
                        if let Err(reinit_err) = self.init_max7219(&board) {
                            log::error!("Matrix {}: reinit also failed: {reinit_err}", self.base.id);
                            break;
                        }
                    }
                }
            }
        }

        if let Some(e) = last_err {
            return Err(e);
        }

        let val = ComponentValue::Array(
            self.config.shapes[clamped].iter().map(|s| ComponentValue::String(s.clone())).collect()
        );
        self.base.set_value(val);
        Ok(())
    }

    fn clear(&mut self) -> Result<(), crate::error::RuntimeError> {
        if let Ok(board) = self.live_board() {
            for row in 1..=8 {
                self.send_to_all(&board, row, 0)?;
            }
        }
        self.base.set_value(ComponentValue::Number(0.0));
        Ok(())
    }
}

impl Component for Matrix {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Matrix" }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        log::info!(
            "Matrix {}: initialize called, board connected={}",
            self.base.id, board.is_connected()
        );
        if !board.is_connected() {
            return Err(crate::error::RuntimeError::BoardNotConnected);
        }
        board.send_command(BoardCommand::SetPinMode {
            pin: self.config.pins.data, mode: pin_mode::OUTPUT,
        })?;
        board.send_command(BoardCommand::SetPinMode {
            pin: self.config.pins.clock, mode: pin_mode::OUTPUT,
        })?;
        board.send_command(BoardCommand::SetPinMode {
            pin: self.config.pins.cs, mode: pin_mode::OUTPUT,
        })?;
        self.board = Some(Arc::clone(&board));
        self.init_max7219(&board)?;
        if !self.config.shapes.is_empty() {
            log::info!("Matrix {}: displaying initial shape", self.base.id);
            self.set_shape(0)?;
        }
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        log::info!("Matrix {}: call_method '{}' board={}",
            self.base.id, method, self.board.is_some());
        match method {
            "value" => {
                let index = args.as_number().unwrap_or(0.0).round() as usize;
                self.set_shape(index)
            }
            "reset" => {
                self.current_shape_index = 0;
                self.clear()
            }
            "reinitialize" => self.reinitialize(),
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        log::info!("Matrix {}: destroy", self.base.id);
        let _ = self.clear();
        if let Ok(board) = self.live_board() {
            let _ = self.send_to_all(&board, REG_SHUTDOWN, 0);
        }
        self.board = None;
    }
}
