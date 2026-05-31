//! Gate Component — Transformation. Template port for the workflow node fan-out.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GateType {
    #[default]
    And,
    Nand,
    Or,
    Xor,
    Nor,
    Xnor,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GateConfig {
    #[serde(default)]
    pub gate: GateType,
}

pub struct Gate {
    base: ComponentBase,
    config: GateConfig,
}

impl Gate {
    #[must_use]
    pub fn new(id: String, config: GateConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
        }
    }

    fn check(&mut self, inputs: &[bool]) {
        let result = self.passes_gate(inputs);
        self.base.set_value(ComponentValue::Bool(result));
        self.base.emit(if result { "true" } else { "false" });
    }

    fn passes_gate(&self, inputs: &[bool]) -> bool {
        let true_count = inputs.iter().filter(|&&b| b).count();
        let total = inputs.len();
        match self.config.gate {
            GateType::And => true_count == total,
            GateType::Nand => true_count != total,
            GateType::Or => true_count > 0,
            GateType::Xor => true_count == 1,
            GateType::Nor => true_count == 0,
            GateType::Xnor => true_count != 1,
        }
    }
}

impl Component for Gate {
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
        "Gate"
    }
    fn aggregates_inputs(&self) -> bool {
        true
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "value" => {
                let inputs: Vec<bool> = match args {
                    ComponentValue::Array(arr) => arr.iter().map(ComponentValue::is_truthy).collect(),
                    other => vec![other.is_truthy()],
                };
                if !inputs.is_empty() {
                    self.check(&inputs);
                }
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl ComponentBuilder for Gate {
    type Config = GateConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
