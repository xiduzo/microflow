//! Matrix Node config — shared by the live runtime and the codegen emitter.
//!
//! The MAX7219 data/clock/CS pins, the number of chained devices, and the
//! shapes: rows of binary strings (`"01111110…"`), one row list per shape.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MatrixPins {
    #[serde(default = "default_data", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub(crate) data: u8,
    #[serde(default = "default_clock", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub(crate) clock: u8,
    #[serde(default = "default_cs", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub(crate) cs: u8,
}

fn default_data() -> u8 { 2 }
fn default_clock() -> u8 { 3 }
fn default_cs() -> u8 { 4 }

impl Default for MatrixPins {
    fn default() -> Self {
        Self { data: default_data(), clock: default_clock(), cs: default_cs() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MatrixConfig {
    #[serde(default)]
    pub(crate) pins: MatrixPins,
    #[serde(default = "default_devices", deserialize_with = "serde_utils::deserialize_whole")]
    pub(crate) devices: u8,
    #[serde(default = "default_dims")]
    pub(crate) dims: String,
    #[serde(default)]
    pub(crate) shapes: Vec<Vec<String>>,
}

impl MatrixConfig {
    /// The MAX7219 intensity (`0`–`15`) the chip init writes, live and in the
    /// sketch. Brightness is not a setting of the node; this is Johnny-Five's
    /// `LedControl` init value, which the live runtime has always used.
    pub(crate) const INTENSITY: u8 = 3;
}

fn default_devices() -> u8 { 1 }
fn default_dims() -> String { "8x8".to_string() }
