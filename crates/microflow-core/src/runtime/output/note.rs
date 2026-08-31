//! Note Component — Output. A canvas annotation; it holds no value and has no
//! wire interface. It exists in the registry only so the catalog (and the
//! frontend types generated from it) can carry the node type.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NoteConfig {}

pub struct Note {
    base: ComponentBase,
}

impl Note {
    #[must_use]
    pub fn new(id: String, _config: NoteConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
        }
    }
}

impl Component for Note {
    fn ports() -> &'static [&'static str] {
        &[]
    }

    fn emits() -> &'static [&'static str] {
        &[]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Note"
    }

    fn dispatch(
        &mut self,
        method: &str,
        _args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        Err(RuntimeError::ComponentError(format!("Unknown method: {method}")))
    }
}

impl ComponentBuilder for Note {
    type Config = NoteConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
