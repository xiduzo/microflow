//! LED Matrix Component - Output (MAX7219)
//!
//! Drives a MAX7219-based LED matrix via bit-banged SPI.
//! Uses `ShiftOut` board command for atomic byte transfers matching
//! Johnny-Five's `LedControl.send()` approach.

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentEvent,
    ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

// MAX7219 registers
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

    /// Send a register+data command to a specific device in the chain.
    /// Mirrors Johnny-Five's `LedControl.send()` approach:
    /// - Build a buffer of (devices * 2) bytes, all zeros (NOOPs)
    /// - Place opcode and data for the target device
    /// - Pull CS low, shift out all bytes in reverse order, pull CS high
    fn send(&self, board: &Arc<BoardHandle>, addr: u8, opcode: u8, data: u8) -> Result<(), String> {
        let offset = (addr as usize) * 2;
        let max_bytes = (self.config.devices as usize) * 2;
        let mut spi_data = vec![0u8; max_bytes];

        if (addr as usize) < self.config.devices as usize {
            spi_data[offset + 1] = opcode;
            spi_data[offset] = data;

            board.send_command(BoardCommand::DigitalWrite {
                pin: self.config.pins.cs,
                value: false,
            })?;

            for j in (0..max_bytes).rev() {
                board.send_command(BoardCommand::ShiftOut {
                    data_pin: self.config.pins.data,
                    clock_pin: self.config.pins.clock,
                    value: spi_data[j],
                })?;
            }

            board.send_command(BoardCommand::DigitalWrite {
                pin: self.config.pins.cs,
                value: true,
            })?;
        }
        Ok(())
    }

    /// Send a command to all devices.
    fn send_to_all(&self, board: &Arc<BoardHandle>, opcode: u8, data: u8) -> Result<(), String> {
        for device in 0..self.config.devices {
            self.send(board, device, opcode, data)?;
        }
        Ok(())
    }

    /// Initialize the MAX7219 chip(s).
    fn init_max7219(&self, board: &Arc<BoardHandle>) -> Result<(), String> {
        log::info!("Matrix {}: initializing MAX7219 (pins: data={}, clock={}, cs={})",
            self.base.id, self.config.pins.data, self.config.pins.clock, self.config.pins.cs);
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

    /// Display a shape on the matrix.
    fn display_shape(&self, board: &Arc<BoardHandle>, shape: &[String]) -> Result<(), String> {
        for device in 0..self.config.devices {
            for row in 0..8u8 {
                let row_idx = row as usize;
                let byte = if row_idx < shape.len() {
                    let row_str = &shape[row_idx];
                    let start = (device as usize) * 8;
                    let end = start + 8;
                    if start < row_str.len() {
                        let slice_end = end.min(row_str.len());
                        u8::from_str_radix(&row_str[start..slice_end], 2).unwrap_or(0)
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

    fn set_shape(&mut self, index: usize) -> Result<(), String> {
        if self.config.shapes.is_empty() {
            log::warn!("Matrix {}: no shapes configured", self.base.id);
            return Ok(());
        }
        let clamped = index.min(self.config.shapes.len() - 1);
        self.current_shape_index = clamped;
        log::info!("Matrix {}: set_shape index={index} clamped={clamped} board={}",
            self.base.id, self.board.is_some());

        if let Some(board) = &self.board {
            let board = Arc::clone(board);
            let shape = self.config.shapes[clamped].clone();
            self.display_shape(&board, &shape)?;
        }

        let shape = &self.config.shapes[clamped];
        let val = ComponentValue::Array(
            shape.iter().map(|s| ComponentValue::String(s.clone())).collect()
        );
        self.base.set_value(val);
        Ok(())
    }

    fn clear(&mut self) -> Result<(), String> {
        if let Some(board) = &self.board {
            for row in 1..=8 {
                self.send_to_all(board, row, 0)?;
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
        log::info!(
            "Matrix {}: initialize called, board connected={}",
            self.base.id, board.is_connected()
        );
        board.send_command(BoardCommand::SetPinMode {
            pin: self.config.pins.data, mode: pin_mode::OUTPUT,
        })?;
        board.send_command(BoardCommand::SetPinMode {
            pin: self.config.pins.clock, mode: pin_mode::OUTPUT,
        })?;
        board.send_command(BoardCommand::SetPinMode {
            pin: self.config.pins.cs, mode: pin_mode::OUTPUT,
        })?;
        // MAX7219 LOAD idles HIGH — set before first transaction
        board.send_command(BoardCommand::DigitalWrite {
            pin: self.config.pins.cs,
            value: true,
        })?;
        self.board = Some(Arc::clone(&board));
        self.init_max7219(&board)?;
        if !self.config.shapes.is_empty() {
            log::info!("Matrix {}: displaying initial shape", self.base.id);
            self.set_shape(0)?;
        }
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
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
            _ => Err(format!("Unknown method: {method}")),
        }
    }

    fn destroy(&mut self) {
        log::info!("Matrix {}: destroy", self.base.id);
        let _ = self.clear();
        if let Some(board) = &self.board {
            let _ = self.send_to_all(board, REG_SHUTDOWN, 0);
        }
        self.board = None;
    }

    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> {
        self.base.event_sender.clone()
    }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) {
        self.base.event_sender = Some(sender);
    }
}
