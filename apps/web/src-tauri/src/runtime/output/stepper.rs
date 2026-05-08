//! Stepper Motor Component - Output
//!
//! Controls stepper motors via Firmata's `AccelStepper` protocol (sysex `0x62`).
//! Supports step/direction driver boards (A4988, DRV8825, TMC2209, `EasyDriver`)
//! as well as 2-wire and 4-wire H-bridge configurations.
//!
//! ## Lifecycle
//! 1. `initialize()` — Sends config, speed, and acceleration sysex messages.
//! 2. `call_method("value", steps)` — Relative move by N steps.
//! 3. `call_method("to", position)` — Absolute move to position.
//! 4. `call_method("stop", _)` — Stop with deceleration.
//! 5. `call_method("zero", _)` — Reset position counter.
//! 6. `call_method("stepper_reply", data)` — Handle move complete / position report.
//! 7. `destroy()` — Stop motor.

use crate::runtime::base::{
    serde_utils, BoardHandle, Component, ComponentBase, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::sync::Arc;

/// `AccelStepper` sysex command byte
const ACCELSTEPPER_DATA: u8 = 0x62;

/// `AccelStepper` sub-commands
const CMD_CONFIG: u8 = 0x00;
const CMD_ZERO: u8 = 0x01;
const CMD_STEP: u8 = 0x02;
const CMD_TO: u8 = 0x03;
const CMD_ENABLE: u8 = 0x04;
const CMD_STOP: u8 = 0x05;
const CMD_SET_ACCEL: u8 = 0x08;
const CMD_SET_SPEED: u8 = 0x09;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StepperInterface {
    #[default]
    Driver,
    TwoWire,
    FourWire,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepperConfig {
    // Driver mode pins (step/dir)
    #[serde(default = "default_step_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub step_pin: u8,
    #[serde(default = "default_dir_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub dir_pin: u8,
    // Four-wire mode pins (IN1–IN4)
    #[serde(default = "default_motor_pin1", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub motor_pin1: u8,
    #[serde(default = "default_motor_pin2", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub motor_pin2: u8,
    #[serde(default = "default_motor_pin3", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub motor_pin3: u8,
    #[serde(default = "default_motor_pin4", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub motor_pin4: u8,
    #[serde(default = "default_steps_per_rev")]
    pub steps_per_rev: u16,
    #[serde(default = "default_speed")]
    pub speed: f32,
    #[serde(default = "default_acceleration")]
    pub acceleration: f32,
    #[serde(default)]
    pub device_num: u8,
    #[serde(default)]
    pub interface: StepperInterface,
    #[serde(default)]
    pub enable_pin: Option<u8>,
}

fn default_step_pin() -> u8 { 2 }
fn default_dir_pin() -> u8 { 3 }
fn default_motor_pin1() -> u8 { 4 }
fn default_motor_pin2() -> u8 { 5 }
fn default_motor_pin3() -> u8 { 6 }
fn default_motor_pin4() -> u8 { 7 }
fn default_steps_per_rev() -> u16 { 200 }
fn default_speed() -> f32 { 200.0 }
fn default_acceleration() -> f32 { 100.0 }

impl Default for StepperConfig {
    fn default() -> Self {
        Self {
            step_pin: default_step_pin(),
            dir_pin: default_dir_pin(),
            motor_pin1: default_motor_pin1(),
            motor_pin2: default_motor_pin2(),
            motor_pin3: default_motor_pin3(),
            motor_pin4: default_motor_pin4(),
            steps_per_rev: default_steps_per_rev(),
            speed: default_speed(),
            acceleration: default_acceleration(),
            device_num: 0,
            interface: StepperInterface::default(),
            enable_pin: None,
        }
    }
}

pub struct Stepper {
    base: ComponentBase,
    config: StepperConfig,
    board: Option<Arc<BoardHandle>>,
    current_position: i32,
}

impl Stepper {
    #[must_use]
    pub fn new(id: String, config: StepperConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            board: None,
            current_position: 0,
        }
    }

    /// Send a sysex message for the `AccelStepper` protocol.
    fn send_sysex(&self, data: Vec<u8>) -> Result<(), crate::error::RuntimeError> {
        if let Some(board) = &self.board {
            board.sysex(ACCELSTEPPER_DATA, data)?;
        }
        Ok(())
    }

    /// Build the config sysex message and send it.
    fn send_config(&self) -> Result<(), crate::error::RuntimeError> {
        let interface_byte = match self.config.interface {
            StepperInterface::Driver => 0b0010000u8,   // 001XXXX = driver
            StepperInterface::TwoWire => 0b0100000u8,  // 010XXXX = two wire
            StepperInterface::FourWire => 0b1000000u8,  // 100XXXX = four wire
        };

        // Add enable pin bit if present
        let interface_byte = if self.config.enable_pin.is_some() {
            interface_byte | 0x01
        } else {
            interface_byte
        };

        let mut data = vec![
            CMD_CONFIG,
            self.config.device_num,
            interface_byte,
        ];

        // Append pins based on interface type
        match self.config.interface {
            StepperInterface::Driver => {
                data.push(self.config.step_pin);
                data.push(self.config.dir_pin);
            }
            StepperInterface::TwoWire => {
                data.push(self.config.motor_pin1);
                data.push(self.config.motor_pin2);
            }
            StepperInterface::FourWire => {
                data.push(self.config.motor_pin1);
                data.push(self.config.motor_pin2);
                data.push(self.config.motor_pin3);
                data.push(self.config.motor_pin4);
            }
        }

        if let Some(enable_pin) = self.config.enable_pin {
            data.push(enable_pin);
        }

        self.send_sysex(data)
    }

    /// Encode a float into `AccelStepper`'s custom 4-byte format.
    /// 23-bit significand + 4-bit exponent (biased -11) + 1-bit sign.
    fn encode_custom_float(value: f32) -> [u8; 4] {
        if value == 0.0 {
            return [0, 0, 0, 0];
        }

        let sign: u8 = u8::from(value < 0.0);
        let mut val = value.abs();

        // Find exponent: we need to express val as significand * 10^(exp-11)
        // where significand fits in 23 bits (max 8388607).
        let mut exp: i8 = 11; // bias
        while val < 1.0 && exp > 0 {
            val *= 10.0;
            exp -= 1;
        }
        while val >= 8_388_608.0 && exp < 15 {
            val /= 10.0;
            exp += 1;
        }

        let significand = (val as u32).min(0x7F_FFFF); // 23 bits max
        let exp_bits = (exp as u8) & 0x0F;

        // Pack into 4 bytes of 7-bit data:
        // byte 0: bits 0-6 of significand
        // byte 1: bits 7-13 of significand
        // byte 2: bits 14-20 of significand
        // byte 3: bits 21-22 of significand + sign (bit 5) + exponent (bits 2-5... actually bits 22-25)
        let b0 = (significand & 0x7F) as u8;
        let b1 = ((significand >> 7) & 0x7F) as u8;
        let b2 = ((significand >> 14) & 0x7F) as u8;
        let b3 = ((significand >> 21) & 0x03) as u8
            | (sign << 5)
            | (exp_bits << 2);

        // Mask to 7-bit
        [b0, b1, b2, b3 & 0x7F]
    }

    /// Encode a 32-bit signed integer into 5 bytes of 7-bit data.
    fn encode_signed_long(value: i32) -> [u8; 5] {
        let v = value as u32;
        [
            (v & 0x7F) as u8,
            ((v >> 7) & 0x7F) as u8,
            ((v >> 14) & 0x7F) as u8,
            ((v >> 21) & 0x7F) as u8,
            ((v >> 28) & 0x0F) as u8,
        ]
    }

    /// Decode a 32-bit signed integer from 5 bytes of 7-bit data.
    #[must_use]
    pub fn decode_signed_long(bytes: &[u8]) -> i32 {
        if bytes.len() < 5 {
            return 0;
        }
        let v = u32::from(bytes[0] & 0x7F)
            | (u32::from(bytes[1] & 0x7F) << 7)
            | (u32::from(bytes[2] & 0x7F) << 14)
            | (u32::from(bytes[3] & 0x7F) << 21)
            | (u32::from(bytes[4] & 0x0F) << 28);
        v as i32
    }

    /// Send set-speed sysex.
    fn send_speed(&self) -> Result<(), crate::error::RuntimeError> {
        let encoded = Self::encode_custom_float(self.config.speed);
        self.send_sysex(vec![
            CMD_SET_SPEED,
            self.config.device_num,
            encoded[0], encoded[1], encoded[2], encoded[3],
        ])
    }

    /// Send set-acceleration sysex.
    fn send_acceleration(&self) -> Result<(), crate::error::RuntimeError> {
        if self.config.acceleration <= 0.0 {
            return Ok(());
        }
        let encoded = Self::encode_custom_float(self.config.acceleration);
        self.send_sysex(vec![
            CMD_SET_ACCEL,
            self.config.device_num,
            encoded[0], encoded[1], encoded[2], encoded[3],
        ])
    }

    /// Relative move by N steps.
    pub fn step(&mut self, steps: i32) -> Result<(), crate::error::RuntimeError> {
        let encoded = Self::encode_signed_long(steps);
        self.send_sysex(vec![
            CMD_STEP,
            self.config.device_num,
            encoded[0], encoded[1], encoded[2], encoded[3], encoded[4],
        ])
    }

    /// Absolute move to position.
    pub fn move_to(&mut self, position: i32) -> Result<(), crate::error::RuntimeError> {
        let encoded = Self::encode_signed_long(position);
        self.send_sysex(vec![
            CMD_TO,
            self.config.device_num,
            encoded[0], encoded[1], encoded[2], encoded[3], encoded[4],
        ])
    }

    /// Stop the motor (decelerates if acceleration is set).
    pub fn stop(&mut self) -> Result<(), crate::error::RuntimeError> {
        self.send_sysex(vec![CMD_STOP, self.config.device_num])
    }

    /// Reset position counter to zero.
    pub fn zero(&mut self) -> Result<(), crate::error::RuntimeError> {
        self.current_position = 0;
        self.base.set_value(ComponentValue::Number(0.0));
        self.send_sysex(vec![CMD_ZERO, self.config.device_num])
    }

    /// Enable or disable the driver (if enable pin is configured).
    pub fn enable(&mut self, state: bool) -> Result<(), crate::error::RuntimeError> {
        self.send_sysex(vec![
            CMD_ENABLE,
            self.config.device_num,
            u8::from(state),
        ])
    }
}

impl Component for Stepper {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Stepper" }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        log::info!(
            "Stepper {} initialize: device={}, step_pin={}, dir_pin={}, speed={}, accel={}",
            self.base.id, self.config.device_num, self.config.step_pin,
            self.config.dir_pin, self.config.speed, self.config.acceleration
        );

        self.board = Some(board);

        // 1. Send stepper config (pins, interface type)
        self.send_config()?;
        // 2. Set max speed
        self.send_speed()?;
        // 3. Set acceleration (if non-zero)
        self.send_acceleration()?;
        // 4. Enable driver if enable pin is configured
        if self.config.enable_pin.is_some() {
            self.enable(true)?;
        }

        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "value" => {
                // Relative move: number of steps
                let steps = args.as_number().unwrap_or(0.0) as i32;
                if steps != 0 {
                    self.step(steps)?;
                }
                Ok(())
            }
            "to" => {
                // Absolute move: target position
                let position = args.as_number().unwrap_or(0.0) as i32;
                self.move_to(position)?;
                Ok(())
            }
            "stop" => self.stop(),
            "zero" => self.zero(),
            "enable" => {
                let state = args.as_number().map_or(true, |n| n > 0.0);
                self.enable(state)
            }
            "stepper_reply" => {
                // Called by the reader thread when a move-complete or position-report
                // sysex reply arrives for this device number.
                // args is expected to be a Number (the decoded position).
                if let Some(position) = args.as_number() {
                    self.current_position = position as i32;
                    self.base.set_value(ComponentValue::Number(position));
                    // Emit on the "position" handle
                    self.base.emit("position");
                    // Emit on the "complete" handle to signal move finished
                    self.base.emit_with_value("complete", Cow::Owned(ComponentValue::Bool(true)));
                }
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(
                format!("Stepper: unknown method '{method}'")
            )),
        }
    }

    fn destroy(&mut self) {
        let _ = self.stop();
        if self.config.enable_pin.is_some() {
            let _ = self.enable(false);
        }
        self.board = None;
    }
}
