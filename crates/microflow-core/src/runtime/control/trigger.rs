//! Trigger Component — Control

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
use std::borrow::Cow;
use std::time::Instant;
// `TriggerConfig` + `TriggerBehaviour` moved to the ungated `config::trigger`
// module so the codegen emitter shares the exact same fields + defaults (single
// source of truth — see `crate::config`). Re-exported so this module's impls are
// unchanged.
pub use crate::config::trigger::{TriggerBehaviour, TriggerConfig};

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
        self.history
            .retain(|entry| now.duration_since(entry.timestamp) <= within_duration);
        self.history.push(ValueWithTimestamp {
            value: value_num,
            timestamp: now,
        });

        let should_bang = self.check_difference(value_num);
        if should_bang {
            self.base
                .emit_with_value("bang", Cow::Owned(ComponentValue::Number(value_num)));
        }
    }

    fn check_difference(&mut self, value: f64) -> bool {
        if self.history.is_empty() {
            return false;
        }

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
    fn ports() -> &'static [&'static str] {
        &["value"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Trigger"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "value" => {
                self.signal(&args);
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!(
                "Unknown method: {method}"
            ))),
        }
    }

    fn destroy(&mut self) {
        self.history.clear();
    }
}

impl ComponentBuilder for Trigger {
    type Config = TriggerConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
