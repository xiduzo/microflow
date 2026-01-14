//! Compare Component - Transformation

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CompareValidator {
    #[default]
    Boolean,
    Number,
    OddEven,
    Range,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RangeConfig {
    #[serde(default)]
    pub min: f64,
    #[serde(default = "default_max")]
    pub max: f64,
}

fn default_max() -> f64 { 100.0 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareConfig {
    #[serde(default)]
    pub validator: CompareValidator,
    #[serde(default, rename = "subValidator")]
    pub sub_validator: String,
    #[serde(default)]
    pub number: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub range: RangeConfig,
}

impl Default for CompareConfig {
    fn default() -> Self {
        Self {
            validator: CompareValidator::default(),
            sub_validator: "true".to_string(),
            number: 0.0,
            text: String::new(),
            range: RangeConfig::default(),
        }
    }
}

pub struct Compare {
    base: ComponentBase,
    config: CompareConfig,
}

impl Compare {
    pub fn new(id: String, config: CompareConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
        }
    }

    pub fn check(&mut self, input: ComponentValue) {
        let result = self.validate(&input);
        self.base.value = ComponentValue::Bool(result);
        self.base.emit(if result { "true" } else { "false" });
    }

    fn validate(&self, input: &ComponentValue) -> bool {
        match self.config.validator {
            CompareValidator::Boolean => input.as_bool().unwrap_or(false),
            CompareValidator::OddEven => {
                let n = input.as_number().unwrap_or(0.0).round() as i64;
                match self.config.sub_validator.as_str() {
                    "odd" => n % 2 != 0,
                    "even" | _ => n % 2 == 0,
                }
            }
            CompareValidator::Number => {
                let n = input.as_number().unwrap_or(0.0);
                match self.config.sub_validator.as_str() {
                    "greater than" => n > self.config.number,
                    "less than" => n < self.config.number,
                    "equal to" | _ => (n - self.config.number).abs() < f64::EPSILON,
                }
            }
            CompareValidator::Range => {
                let n = input.as_number().unwrap_or(0.0);
                match self.config.sub_validator.as_str() {
                    "outside" => n < self.config.range.min || n > self.config.range.max,
                    "between" | _ => n > self.config.range.min && n < self.config.range.max,
                }
            }
            CompareValidator::Text => {
                let s = match input {
                    ComponentValue::String(s) => s.clone(),
                    ComponentValue::Number(n) => n.to_string(),
                    ComponentValue::Bool(b) => b.to_string(),
                    _ => String::new(),
                };
                match self.config.sub_validator.as_str() {
                    "including" => s.contains(&self.config.text),
                    "starting with" => s.starts_with(&self.config.text),
                    "ending with" => s.ends_with(&self.config.text),
                    "equal to" | _ => s == self.config.text,
                }
            }
        }
    }
}

impl Component for Compare {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Compare" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "check" => { self.check(args); Ok(()) }
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) {}
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
