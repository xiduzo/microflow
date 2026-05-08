//! I2C Device Component - Input
//!
//! Generic I2C device node that can read from and write to any I2C peripheral.
//! Uses Firmata's I2C protocol via `BoardCommand` variants.
//!
//! ## Lifecycle
//! 1. `initialize()` — Sends `I2C_CONFIG`, then writes the register address and
//!    starts a continuous read for the configured number of bytes.
//! 2. Reader thread drains `I2CReply` from `firmata_rs` and routes them here
//!    via `call_method("i2c_reply", ...)`.
//! 3. `destroy()` — Sends I2C stop reading command.

use crate::runtime::base::{BoardHandle, Component, ComponentBase, ComponentValue};
use crate::runtime::wiring::ListenerWiring;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    Raw,
    #[default]
    UnsignedInt,
    SignedInt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct I2cDeviceConfig {
    #[serde(default = "default_address")]
    pub address: u8,
    #[serde(default)]
    pub register: u8,
    #[serde(default = "default_read_length")]
    pub read_length: u8,
    #[serde(default = "default_freq")]
    pub freq: u32,
    #[serde(default = "default_device")]
    pub device: String,
    #[serde(default)]
    pub output: OutputFormat,
}

fn default_address() -> u8 { 0x48 }
fn default_read_length() -> u8 { 2 }
fn default_freq() -> u32 { 100 }
fn default_device() -> String { "custom".to_string() }

impl Default for I2cDeviceConfig {
    fn default() -> Self {
        Self {
            address: default_address(),
            register: 0,
            read_length: default_read_length(),
            freq: default_freq(),
            device: default_device(),
            output: OutputFormat::default(),
        }
    }
}

pub struct I2cDevice {
    base: ComponentBase,
    config: I2cDeviceConfig,
    board: Option<Arc<BoardHandle>>,
    initialized: bool,
}

impl I2cDevice {
    #[must_use]
    pub fn new(id: String, config: I2cDeviceConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            board: None,
            initialized: false,
        }
    }

    /// Convert raw I2C reply bytes to a `ComponentValue` based on the output format.
    fn convert_bytes(&self, data: &[u8]) -> ComponentValue {
        match self.config.output {
            OutputFormat::Raw => {
                ComponentValue::Array(
                    data.iter().map(|&b| ComponentValue::Number(f64::from(b))).collect()
                )
            }
            OutputFormat::UnsignedInt => {
                // Big-endian unsigned integer from up to 4 bytes
                let mut value: u32 = 0;
                for &byte in data.iter().take(4) {
                    value = (value << 8) | u32::from(byte);
                }
                ComponentValue::Number(f64::from(value))
            }
            OutputFormat::SignedInt => {
                // Big-endian signed integer (two's complement) from up to 4 bytes
                let len = data.len().min(4);
                if len == 0 {
                    return ComponentValue::Number(0.0);
                }
                let mut value: i32 = if data[0] & 0x80 != 0 { -1 } else { 0 };
                for &byte in data.iter().take(len) {
                    value = (value << 8) | i32::from(byte);
                }
                ComponentValue::Number(f64::from(value))
            }
        }
    }

    /// Send a one-shot I2C read: write register address, then read N bytes.
    fn request_read(&self) -> Result<(), crate::error::RuntimeError> {
        if let Some(board) = &self.board {
            // Write the register address first (sets the device's internal pointer)
            if self.config.register != 0 {
                board.i2c_write(i32::from(self.config.address), vec![self.config.register])?;
            }
            // Request a read
            board.i2c_read(i32::from(self.config.address), i32::from(self.config.read_length))?;
        }
        Ok(())
    }
}

impl Component for I2cDevice {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "I2cDevice" }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::I2cAddress { address: self.config.address }]
    }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        log::info!(
            "I2cDevice {} initialize: address=0x{:02X}, register=0x{:02X}, read_length={}, output={:?}",
            self.base.id, self.config.address, self.config.register,
            self.config.read_length, self.config.output
        );

        // Configure I2C bus (delay=0 for most devices)
        board.i2c_config(0)?;

        self.board = Some(board);
        self.initialized = true;

        // Start initial read
        self.request_read()?;

        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "i2c_reply" => {
                // Called by the reader thread when an I2C reply arrives for our address.
                // args is an Array of byte values.
                if let ComponentValue::Array(bytes) = &args {
                    let raw: Vec<u8> = bytes.iter()
                        .filter_map(|v| v.as_number().map(|n| n as u8))
                        .collect();

                    let value = self.convert_bytes(&raw);
                    self.base.set_value(value);
                    self.base.emit("value");

                    // Schedule next read after processing
                    let _ = self.request_read();
                }
                Ok(())
            }
            "write" => {
                // Write data to the I2C device. Input can be a number or array of numbers.
                if let Some(board) = &self.board {
                    let mut data = vec![self.config.register];
                    match &args {
                        ComponentValue::Number(n) => {
                            data.push(*n as u8);
                        }
                        ComponentValue::Array(arr) => {
                            for v in arr {
                                if let Some(n) = v.as_number() {
                                    data.push(n as u8);
                                }
                            }
                        }
                        _ => {}
                    }
                    board.i2c_write(i32::from(self.config.address), data)?;
                    self.base.emit("value");
                }
                Ok(())
            }
            "trigger" => {
                // One-shot read triggered by command handle
                self.request_read()?;
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(
                format!("I2cDevice: unknown method '{method}'")
            )),
        }
    }

    fn destroy(&mut self) {
        if self.initialized {
            if let Some(board) = &self.board {
                log::info!("I2cDevice {} destroy: stopping I2C reads for address 0x{:02X}",
                    self.base.id, self.config.address);
                let _ = board.i2c_stop_reading(i32::from(self.config.address));
            }
        }
        self.board = None;
        self.initialized = false;
    }
}
