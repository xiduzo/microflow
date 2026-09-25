//! Piezo Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum PiezoType {
    #[default]
    Buzz,
    Song,
}

pub type Note = (Option<String>, f64);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiezoConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub r#type: PiezoType,
    #[serde(default = "default_duration")]
    pub duration: u32,
    #[serde(default = "default_frequency")]
    pub frequency: u32,
    #[serde(default)]
    pub song: Vec<Note>,
    #[serde(default = "default_tempo")]
    pub tempo: u32,
}

fn default_pin() -> u8 { 11 }
fn default_duration() -> u32 { 500 }
fn default_frequency() -> u32 { 440 }
fn default_tempo() -> u32 { 113 }

impl Default for PiezoConfig {
    fn default() -> Self {
        Self { pin: default_pin(), r#type: PiezoType::default(), duration: default_duration(), frequency: default_frequency(), song: Vec::new(), tempo: default_tempo() }
    }
}
