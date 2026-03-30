//! LED Matrix Component - Output (MAX7219)
//!
//! Drives a MAX7219-based LED matrix via bit-banged SPI using digital writes.
//! Receives a shape index number and displays the corresponding pattern.

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentEvent,
    ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

// MAX7219 registers
const REG_NOOP: u8 = 0x00;
const REG_DECODE_MODE: u8 = 0x09;
const REG_INTENSITY: u8 = 0x0A;
const REG_SCAN_LIMIT: u8 = 0x0B;
const REG_SHUTDOWN: u8 = 0x0C;
const REG_DISPLAY_TEST: u8 = 0x0F;

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
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            board: None,
            current_shape_index: 0,
        }
    }

    /// Bit-bang a single byte out the data pin, MSB first.
    fn shift_out(&self, board: &Arc<BoardHandle>, byte: u8) -> Result<(), String> {
        for i in (0..8).rev() {
            let bit = (byte >> i) & 1 == 1;
            board.send_command(BoardCommand::DigitalWrite { pin: self.config.pins.data, value: bit })?;
            board.send_command(BoardCommand::DigitalWrite { pin: self.config.pins.clock, value: true })?;
            board.send_command(BoardCommand::DigitalWrite { pin: self.config.pins.clock, value: false })?;
        }
        Ok(())
    }

    /// Send a register+data pair to all chained devices.
    fn send_command_to_all(&self, board: &Arc<BoardHandle>, register: u8, data: u8) -> Result<(), String> {
        board.send_command(BoardCommand::DigitalWrite { pin: self.config.pins.cs, value: false })?;
        for _ in 0..self.config.devices {
            self.shift_out(board, register)?;
            self.shift_out(board, data)?;
        }
        board.send_command(BoardCommand::DigitalWrite { pin: self.config.pins.cs, value: true })?;
        Ok(())
    }

    /// Send a register+data pair to a specific device in the chain.
    fn send_to_device(&self, board: &Arc<BoardHandle>, device: u8, register: u8, data: u8) -> Result<(), String> {
        board.send_command(BoardCommand::DigitalWrite { pin: self.config.pins.cs, value: false })?;
        // Devices are daisy-chained: last shifted data goes to first device.
        // Send NOOPs to devices after the target, then the real command, then NOOPs before.
        for d in (0..self.config.devices).rev() {
            if d == device {
                self.shift_out(board, register)?;
                self.shift_out(board, data)?;
            } else {
                self.shift_out(board, REG_NOOP)?;
                self.shift_out(board, 0)?;
            }
        }
        board.send_command(BoardCommand::DigitalWrite { pin: self.config.pins.cs, value: true })?;
        Ok(())
    }

    /// Initialize the MAX7219 chip(s).
    fn init_max7219(&self, board: &Arc<BoardHandle>) -> Result<(), String> {
        self.send_command_to_all(board, REG_DISPLAY_TEST, 0)?;
        self.send_command_to_all(board, REG_SCAN_LIMIT, 7)?;
        self.send_command_to_all(board, REG_DECODE_MODE, 0)?;
        self.send_command_to_all(board, REG_INTENSITY, 4)?;
        self.send_command_to_all(board, REG_SHUTDOWN, 1)?;
        // Clear all rows
        for row in 1..=8 {
            self.send_command_to_all(board, row, 0)?;
        }
        Ok(())
    }

    /// Display a shape (array of binary strings) on the matrix.
    fn display_shape(&self, board: &Arc<BoardHandle>, shape: &[String]) -> Result<(), String> {
        let cols_per_device = 8u8;
        for device in 0..self.config.devices {
            for row in 0..8u8 {
                let row_idx = row as usize;
                let byte = if row_idx < shape.len() {
                    let row_str = &shape[row_idx];
                    let start = (device as usize) * (cols_per_device as usize);
                    let end = start + (cols_per_device as usize);
                    // Parse the relevant 8-bit slice of this row
                    if start < row_str.len() {
                        let slice_end = end.min(row_str.len());
                        let slice = &row_str[start..slice_end];
                        u8::from_str_radix(slice, 2).unwrap_or(0)
                    } else {
                        0
                    }
                } else {
                    0
                };
                // MAX7219 rows are registers 1-8
                self.send_to_device(board, device, row + 1, byte)?;
            }
        }
        Ok(())
    }

    /// Set shape by index, clamping to available shapes.
    fn set_shape(&mut self, index: usize) -> Result<(), String> {
        if self.config.shapes.is_empty() {
            return Ok(());
        }
        let clamped = index.min(self.config.shapes.len() - 1);
        self.current_shape_index = clamped;

        if let Some(board) = &self.board {
            let board = Arc::clone(board);
            let shape = self.config.shapes[clamped].clone();
            self.display_shape(&board, &shape)?;
        }

        // Emit the current shape as the value (array of strings)
        let shape = &self.config.shapes[clamped];
        let val = ComponentValue::Array(
            shape.iter().map(|s| ComponentValue::String(s.clone())).collect()
        );
        self.base.set_value(val);
        Ok(())
    }

    /// Clear the display.
    fn clear(&mut self) -> Result<(), String> {
        if let Some(board) = &self.board {
            for row in 1..=8 {
                self.send_command_to_all(board, row, 0)?;
            }
        }
        self.base.set_value(ComponentValue::Number(0.0));
        Ok(())
    }
}

impl Component for Matrix {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Matrix" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        board.send_command(BoardCommand::SetPinMode { pin: self.config.pins.data, mode: pin_mode::OUTPUT })?;
        board.send_command(BoardCommand::SetPinMode { pin: self.config.pins.clock, mode: pin_mode::OUTPUT })?;
        board.send_command(BoardCommand::SetPinMode { pin: self.config.pins.cs, mode: pin_mode::OUTPUT })?;
        self.board = Some(Arc::clone(&board));
        self.init_max7219(&board)?;
        // Display first shape if available
        if !self.config.shapes.is_empty() {
            self.set_shape(0)?;
        }
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "value" => {
                let index = args.as_number().unwrap_or(0.0).round() as usize;
                self.set_shape(index)
            }
            "reset" => {
                self.current_shape_index = 0;
                self.clear()
            }
            _ => Err(format!("Unknown method: {method}")),
        }
    }

    fn destroy(&mut self) {
        let _ = self.clear();
        // Shutdown the MAX7219
        if let Some(board) = &self.board {
            let _ = self.send_command_to_all(board, REG_SHUTDOWN, 0);
        }
        self.board = None;
    }

    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
