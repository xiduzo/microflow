//! Trigger Component - Control

use crate::runtime::base::{Component, ComponentBase, ComponentValue};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerConfig {
    #[serde(default)]
    pub relative: bool,
    #[serde(default = "default_behaviour")]
    pub behaviour: TriggerBehaviour,
    #[serde(default = "default_threshold")]
    pub threshold: f64,
    #[serde(default = "default_within")]
    pub within: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TriggerBehaviour {
    Increasing,
    #[default]
    Decreasing,
}

fn default_behaviour() -> TriggerBehaviour { TriggerBehaviour::Decreasing }
fn default_threshold() -> f64 { 5.0 }
fn default_within() -> u64 { 250 }

impl Default for TriggerConfig {
    fn default() -> Self {
        Self {
            relative: false,
            behaviour: default_behaviour(),
            threshold: default_threshold(),
            within: default_within(),
        }
    }
}

struct ValueWithTimestamp {
    value: f64,
    timestamp: Instant,
}

pub struct Trigger {
    base: ComponentBase,
    config: TriggerConfig,
    history: Vec<ValueWithTimestamp>,
}

impl Trigger {
    #[must_use] 
    pub fn new(id: String, config: TriggerConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            history: Vec::new(),
        }
    }

    pub fn signal(&mut self, value: &ComponentValue) {
        let value_num = value.as_number().unwrap_or(0.0);
        let now = Instant::now();
        let within_duration = std::time::Duration::from_millis(self.config.within);

        // Filter old entries
        self.history.retain(|entry| now.duration_since(entry.timestamp) <= within_duration);
        self.history.push(ValueWithTimestamp { value: value_num, timestamp: now });

        let should_bang = self.check_difference(value_num);
        if should_bang {
            self.base.emit_with_value("bang", Cow::Owned(ComponentValue::Number(value_num)));
        }
    }

    fn check_difference(&mut self, value: f64) -> bool {
        if self.history.is_empty() { return false; }

        let first_value = self.history[0].value;
        let difference = value - first_value;
        let correct_direction = self.value_changes_in_correct_direction(difference);

        let was_triggered = self.base.value.as_bool().unwrap_or(false);
        if was_triggered {
            self.base.set_value(ComponentValue::Bool(correct_direction));
            return false;
        }

        let reached_threshold = if self.config.relative {
            (difference / first_value * 100.0).abs() >= self.config.threshold
        } else {
            difference.abs() >= self.config.threshold
        };

        let triggered = correct_direction && reached_threshold;
        self.base.set_value(ComponentValue::Bool(triggered));
        triggered
    }

    fn value_changes_in_correct_direction(&self, difference: f64) -> bool {
        let is_positive = difference > 0.0;
        match self.config.behaviour {
            TriggerBehaviour::Increasing => is_positive,
            TriggerBehaviour::Decreasing => !is_positive,
        }
    }
}

impl Component for Trigger {
    fn ports() -> &'static [&'static str] { &["value"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Trigger" }

    fn dispatch(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "value" => { self.signal(&args); Ok(()) }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) { self.history.clear(); }
}
