//! Gate Component - Transformation

use crate::runtime::base::{Component, ComponentBase, ComponentValue};
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

    pub fn check(&mut self, inputs: &[bool]) {
        log::info!("[Gate {}] check called with {} inputs: {:?}", self.base.id, inputs.len(), inputs);
        let result = self.passes_gate(inputs);
        log::info!("[Gate {}] gate type {:?}, result: {}", self.base.id, self.config.gate, result);
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
    fn ports() -> &'static [&'static str] { &["value"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Gate" }
    fn aggregates_inputs(&self) -> bool { true }

    fn dispatch(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "value" => {
                log::info!("[Gate {}] dispatch '{}' with args: {:?}", self.base.id, method, args);
                let inputs: Vec<bool> = match args {
                    ComponentValue::Array(arr) => {
                        log::info!("[Gate {}] Processing array of {} items", self.base.id, arr.len());
                        arr.iter().map(|v| {
                            let truthy = v.is_truthy();
                            log::info!("[Gate {}] Input {:?} -> truthy: {}", self.base.id, v, truthy);
                            truthy
                        }).collect()
                    },
                    other => {
                        let truthy = other.is_truthy();
                        log::info!("[Gate {}] Single input {:?} -> truthy: {}", self.base.id, other, truthy);
                        vec![truthy]
                    },
                };

                if !inputs.is_empty() {
                    self.check(&inputs);
                }
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}
