//! Stepper Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StepperInterface {
    #[default]
    Driver,
    TwoWire,
    FourWire,
}

// The web stores camelCase keys (`stepPin`, `motorPin1`, …); without
// `rename_all` every multi-word field silently fell back to its default —
// masked only because the web defaults coincide with the Rust ones.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
