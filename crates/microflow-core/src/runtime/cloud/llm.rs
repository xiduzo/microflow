//! LLM cloud node on core's [`Component`] trait.
//!
//! Sans-IO (ADR-0009): `dispatch("trigger")` emits `thinking = true`
//! synchronously, then records a [`CloudRequestKind::LlmGenerate`] for the host
//! to perform. The host resolves a provider, runs generation off-thread, and
//! feeds the result back via `FlowRuntime::inject_event` on this node's
//! `thinking`/`value`/`done`/`error` handles. The node holds no provider, no
//! Tokio handle, and no abort handle — cancellation (latest-wins) and provider
//! lookup now live in the host's `EffectsSink::perform_cloud`.
//!
//! # Handles
//! - `trigger` (input): any incoming value starts generation
//! - `{{var}}` (input): dynamic prompt template variables
//! - `thinking` / `done` / `value` / `error` (outputs)
//!
//! [`Component`]: crate::runtime::Component

use crate::runtime::{
    CloudRequestKind, Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext,
    RuntimeError,
};
use std::borrow::Cow;
use std::collections::HashMap;

pub use crate::config::llm::LlmConfig;

pub struct Llm {
    base: ComponentBase,
    config: LlmConfig,
    /// Stored values for `{{var}}` template slots in the prompt.
    template_vars: HashMap<String, String>,
}

impl Llm {
    /// Output handles. `pub` so the host's `perform_cloud` injects results on the
    /// exact handles this node declares in [`Component::emits`] — one source of
    /// truth for the LLM result contract (the `value` handle is the shared
    /// [`ComponentBase::VALUE_HANDLE`]).
    pub const E_THINKING: &'static str = "thinking";
    pub const E_DONE: &'static str = "done";
    pub const E_ERROR: &'static str = "error";

    #[must_use]
    pub fn new(id: String, config: LlmConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
            template_vars: HashMap::new(),
        }
    }

    fn build_prompt(&self) -> String {
        let mut prompt = self.config.prompt.clone();
        for (key, value) in &self.template_vars {
            prompt = prompt.replace(&format!("{{{{{key}}}}}"), value);
        }
        prompt
    }
}

impl ComponentBuilder for Llm {
    type Config = LlmConfig;

    fn build(id: String, config: LlmConfig) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl Component for Llm {
    fn ports() -> &'static [&'static str] {
        &["trigger"]
    }

    fn emits() -> &'static [&'static str] {
        &[
            Self::E_THINKING,
            ComponentBase::VALUE_HANDLE,
            Self::E_DONE,
            Self::E_ERROR,
        ]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Llm"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "trigger" => {
                // `thinking = true` fires synchronously (drained this turn);
                // `thinking = false` + `value`/`done`/`error` re-enter later via
                // the host after generation. `emit_with_value` always fires
                // (no value-dedup) so a repeated trigger re-shows the spinner.
                self.base
                    .emit_with_value(Self::E_THINKING, Cow::Owned(ComponentValue::Bool(true)));
                let prompt = self.build_prompt();
                ctx.request_cloud(CloudRequestKind::LlmGenerate {
                    provider_id: self.config.provider_id.clone(),
                    model: self.config.model.clone(),
                    system: if self.config.system.is_empty() {
                        None
                    } else {
                        Some(self.config.system.clone())
                    },
                    prompt,
                });
            }
            var => {
                let val_str = match &args {
                    ComponentValue::String(s) => s.clone(),
                    ComponentValue::Number(n) => n.to_string(),
                    ComponentValue::Bool(b) => b.to_string(),
                    _ => String::new(),
                };
                self.template_vars.insert(var.to_string(), val_str);
            }
        }
        Ok(())
    }

    fn destroy(&mut self) {
        log::info!("[Llm] {} destroyed", self.base.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::cloud::test_support::recorded_cloud_requests;
    use crate::runtime::{ComponentEvent, EventSink};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    fn config() -> LlmConfig {
        LlmConfig {
            provider_id: "p".into(),
            model: "test-model".into(),
            prompt: "hello".into(),
            ..LlmConfig::default()
        }
    }

    /// Unwrap the single recorded request as an LLM generation, or panic.
    fn generate_of(kind: CloudRequestKind) -> (String, String, Option<String>, String) {
        match kind {
            CloudRequestKind::LlmGenerate { provider_id, model, system, prompt } => {
                (provider_id, model, system, prompt)
            }
            other @ CloudRequestKind::MqttPublish { .. } => panic!("expected LlmGenerate, got {other:?}"),
        }
    }

    #[test]
    fn trigger_records_generate_and_emits_thinking() {
        let mut llm = Llm::new("node-1".into(), config());
        let sink: EventSink = Rc::new(RefCell::new(VecDeque::new()));
        llm.set_sink(sink.clone());

        let mut reqs = recorded_cloud_requests("node-1", |ctx| {
            llm.dispatch("trigger", ComponentValue::Bool(true), ctx)
                .expect("trigger ok");
        });

        // `thinking = true` was emitted synchronously on dispatch.
        let events: Vec<ComponentEvent> = sink.borrow_mut().drain(..).collect();
        assert!(events
            .iter()
            .any(|e| e.source_handle.as_ref() == "thinking" && e.value == ComponentValue::Bool(true)));

        assert_eq!(reqs.len(), 1);
        let (provider_id, model, system, prompt) = generate_of(reqs.remove(0));
        assert_eq!(provider_id, "p");
        assert_eq!(model, "test-model");
        assert_eq!(system, None);
        assert_eq!(prompt, "hello");
    }

    #[test]
    fn forwards_system_prompt_when_set() {
        let mut c = config();
        c.system = "you are terse".into();
        let mut llm = Llm::new("node-1".into(), c);

        let mut reqs = recorded_cloud_requests("node-1", |ctx| {
            llm.dispatch("trigger", ComponentValue::Bool(true), ctx).unwrap();
        });

        let (_, _, system, _) = generate_of(reqs.remove(0));
        assert_eq!(system.as_deref(), Some("you are terse"));
    }

    #[test]
    fn substitutes_template_vars_into_prompt() {
        let mut c = config();
        c.prompt = "hello {{name}}".into();
        let mut llm = Llm::new("node-1".into(), c);

        let mut reqs = recorded_cloud_requests("node-1", |ctx| {
            // Set the template var via the {{var}} input port, then trigger.
            llm.dispatch("name", ComponentValue::String("world".into()), ctx).unwrap();
            llm.dispatch("trigger", ComponentValue::Bool(true), ctx).unwrap();
        });

        // Only the trigger records a request; setting a template var does not.
        assert_eq!(reqs.len(), 1);
        let (_, _, _, prompt) = generate_of(reqs.remove(0));
        assert_eq!(prompt, "hello world");
    }
}
