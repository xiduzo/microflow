//! Smooth Component - Transformation

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SmoothType {
    #[default]
    Smooth,
    MovingAverage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmoothConfig {
    #[serde(default, rename = "type")]
    pub smooth_type: SmoothType,
    #[serde(default = "default_attenuation")]
    pub attenuation: f64,
    #[serde(default = "default_window_size", rename = "windowSize")]
    pub window_size: usize,
}

fn default_attenuation() -> f64 { 0.995 }
fn default_window_size() -> usize { 25 }

impl Default for SmoothConfig {
    fn default() -> Self {
        Self {
            smooth_type: SmoothType::default(),
            attenuation: default_attenuation(),
            window_size: default_window_size(),
        }
    }
}

pub struct Smooth {
    base: ComponentBase,
    config: SmoothConfig,
    history: Vec<f64>,
}

impl Smooth {
    #[must_use] 
    pub fn new(id: String, config: SmoothConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            history: Vec::new(),
        }
    }

    pub fn signal(&mut self, value: &ComponentValue) {
        let value_num = value.as_number().unwrap_or(0.0);

        match self.config.smooth_type {
            SmoothType::MovingAverage => self.moving_average(value_num),
            SmoothType::Smooth => self.smooth(value_num),
        }
    }

    fn smooth(&mut self, value: f64) {
        let current = self.base.value.as_number().unwrap_or(0.0);
        let attenuation = self.config.attenuation;
        let result = attenuation * value + (1.0 - attenuation) * current;
        self.base.set_value(ComponentValue::Number(result));
    }

    fn moving_average(&mut self, value: f64) {
        self.history.push(value);

        if self.history.len() > self.config.window_size {
            self.history.remove(0);
        }

        let sum: f64 = self.history.iter().sum();
        let avg = sum / self.history.len() as f64;
        self.base.set_value(ComponentValue::Number(avg));
    }
}

impl Component for Smooth {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Smooth" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "value" => { self.signal(&args); Ok(()) }
            _ => Err(format!("Unknown method: {method}")),
        }
    }

    fn destroy(&mut self) { self.history.clear(); }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
