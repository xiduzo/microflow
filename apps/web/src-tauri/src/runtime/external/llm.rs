//! LLM Component - External
//!
//! Resolves an [`LlmProvider`](crate::runtime::services::LlmProvider) by id
//! against the shared [`LlmRegistry`] and emits the text response downstream.
//!
//! # Handles
//!
//! - `trigger` (input): any incoming value starts generation
//! - `{{var}}` (input): dynamic prompt template variables
//! - `thinking` (output, state): true while generating, false when idle
//! - `done` (output, event): fires when generation completes successfully
//! - `value` (output, value): emits the generated text response
//! - `error` (output, event): fires with an error message when generation fails
//!
//! Provider lookup happens *per dispatch* against [`LlmRegistry`], not at
//! `Llm::build` time — credential rotation via [`LlmRegistry::sync`] takes
//! effect on the next `trigger` without rebuilding the component. See
//! `docs/adr/0002-per-capability-service-traits.md`.

use crate::runtime::base::{Component, ComponentBase, ComponentEvent, ComponentValue};
use crate::runtime::services::{LlmError, LlmRegistry, LlmRequest};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Static config — the structural fields that describe *what* this node
/// generates. Credentials (`base_url`/`api_key`) live on the registry's
/// provider impls now, not on the node config.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    /// Human-facing provider kind label (`ollama`, `openrouter`, …). Not
    /// load-bearing for the runtime; kept for parity with the frontend
    /// schema and surfaced in logs.
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Frontend provider record id; resolved against [`LlmRegistry`] at
    /// dispatch time.
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub system: String,
}

fn default_provider() -> String { "ollama".to_string() }

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            provider_id: String::new(),
            model: String::new(),
            prompt: String::new(),
            system: String::new(),
        }
    }
}

pub struct Llm {
    base: ComponentBase,
    config: LlmConfig,
    /// Stored values for `{{var}}` template slots in the prompt
    template_vars: HashMap<String, String>,
    /// Handle to the Tokio runtime so we can spawn tasks from sync contexts
    rt_handle: Option<tokio::runtime::Handle>,
    /// Abort handle for the currently running generation task
    running_task: Option<tokio::task::AbortHandle>,
    /// Shared LLM provider registry. Cloned into each spawned task so the
    /// lookup happens at dispatch time, not at construction time.
    llm_registry: Arc<LlmRegistry>,
}

impl Llm {
    #[must_use]
    pub fn new(id: String, config: LlmConfig, llm_registry: Arc<LlmRegistry>) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
            template_vars: HashMap::new(),
            rt_handle: tokio::runtime::Handle::try_current().ok(),
            running_task: None,
            llm_registry,
        }
    }

    fn build_prompt(&self) -> String {
        let mut prompt = self.config.prompt.clone();
        for (key, value) in &self.template_vars {
            prompt = prompt.replace(&format!("{{{{{key}}}}}"), value);
        }
        prompt
    }

    fn emit(&self, handle: &'static str, value: ComponentValue) {
        if let Some(sender) = &self.base.event_sender {
            let _ = sender.send(ComponentEvent {
                source: Arc::clone(&self.base.id),
                source_handle: Arc::from(handle),
                value,
                edge_id: None,
                sequence: 0,
            });
        }
    }

    fn spawn_generate(&mut self, prompt: String) {
        // Cancel any in-flight request
        if let Some(abort) = self.running_task.take() {
            log::info!("[Llm] {} cancelling previous task", self.base.id);
            abort.abort();
        }

        let component_id = Arc::clone(&self.base.id);
        let event_sender = self.base.event_sender.clone();
        let registry = Arc::clone(&self.llm_registry);
        let provider_id = self.config.provider_id.clone();
        let request = LlmRequest {
            model: self.config.model.clone(),
            system: if self.config.system.is_empty() {
                None
            } else {
                Some(self.config.system.clone())
            },
            prompt,
        };

        let Some(handle) = &self.rt_handle else {
            log::error!("[Llm] {component_id} no Tokio runtime available, cannot spawn task");
            return;
        };

        let join_handle = handle.spawn(async move {
            let send = |handle: &str, value: ComponentValue| {
                if let Some(sender) = &event_sender {
                    let _ = sender.send(ComponentEvent {
                        source: Arc::clone(&component_id),
                        source_handle: Arc::from(handle),
                        value,
                        edge_id: None,
                        sequence: 0,
                    });
                }
            };

            let Some(provider) = registry.get(&provider_id).await else {
                log::error!(
                    "[Llm] {component_id} provider '{provider_id}' not in registry"
                );
                send("thinking", ComponentValue::Bool(false));
                send(
                    "error",
                    ComponentValue::String(format!(
                        "LLM provider '{provider_id}' not configured"
                    )),
                );
                return;
            };

            log::info!(
                "[Llm] {component_id} → provider={provider_id} model={}",
                request.model
            );

            match provider.generate(request).await {
                Ok(response) => {
                    log::info!(
                        "[Llm] {component_id} response: {} chars",
                        response.text.len()
                    );
                    send("thinking", ComponentValue::Bool(false));
                    send("value", ComponentValue::String(response.text));
                    send("done", ComponentValue::Bool(true));
                }
                Err(LlmError::Cancelled) => {
                    log::info!("[Llm] {component_id} cancelled");
                    // No error event; the abort path disowned this task.
                }
                Err(e) => {
                    log::error!("[Llm] {component_id} generate failed: {e}");
                    send("thinking", ComponentValue::Bool(false));
                    send("error", ComponentValue::String(e.to_string()));
                }
            }
        });

        self.running_task = Some(join_handle.abort_handle());
    }
}

impl Component for Llm {
    fn ports() -> &'static [&'static str] { &["trigger"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Llm" }

    fn dispatch(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "trigger" => {
                self.emit("thinking", ComponentValue::Bool(true));
                let prompt = self.build_prompt();
                self.spawn_generate(prompt);
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
        if let Some(abort) = self.running_task.take() {
            abort.abort();
        }
        log::info!("[Llm] {} destroyed", self.base.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::services::{LlmProvider, RecordingLlmProvider};
    use std::time::Duration;
    use tokio::sync::mpsc;

    /// Drain events until either the `done` handle fires or the deadline
    /// elapses. Returns the collected events in arrival order.
    async fn drain_until_done(
        rx: &mut mpsc::UnboundedReceiver<ComponentEvent>,
        timeout: Duration,
    ) -> Vec<ComponentEvent> {
        let mut events = Vec::new();
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(20), rx.recv()).await {
                Ok(Some(event)) => {
                    let handle = event.source_handle.clone();
                    events.push(event);
                    if handle.as_ref() == "done" || handle.as_ref() == "error" {
                        return events;
                    }
                }
                Ok(None) => return events,
                Err(_) => continue,
            }
        }
        events
    }

    #[tokio::test]
    async fn dispatches_to_registry_provider_and_emits_value() {
        let registry = Arc::new(LlmRegistry::new());
        let recorder = Arc::new(RecordingLlmProvider::new());
        recorder.script_ok("hi back");
        registry
            .insert("test-provider".into(), recorder.clone() as Arc<dyn LlmProvider>)
            .await;

        let (tx, mut rx) = mpsc::unbounded_channel();
        let config = LlmConfig {
            provider_id: "test-provider".into(),
            model: "test-model".into(),
            prompt: "hello".into(),
            ..LlmConfig::default()
        };

        let mut llm = Llm::new("node-1".into(), config, Arc::clone(&registry));
        llm.set_event_sender(tx);

        llm.dispatch("trigger", ComponentValue::Bool(true))
            .expect("trigger ok");

        let events = drain_until_done(&mut rx, Duration::from_secs(2)).await;

        let value = events.iter().find_map(|e| {
            if e.source_handle.as_ref() == "value" {
                if let ComponentValue::String(s) = &e.value {
                    return Some(s.clone());
                }
            }
            None
        });
        assert_eq!(value.as_deref(), Some("hi back"));
        assert!(events
            .iter()
            .any(|e| e.source_handle.as_ref() == "done"));

        let calls = recorder.recorded();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].model, "test-model");
        assert_eq!(calls[0].prompt, "hello");
        assert!(calls[0].system.is_none());
    }

    #[tokio::test]
    async fn emits_error_when_provider_not_in_registry() {
        let registry = Arc::new(LlmRegistry::new()); // empty
        let (tx, mut rx) = mpsc::unbounded_channel();
        let config = LlmConfig {
            provider_id: "missing".into(),
            ..LlmConfig::default()
        };
        let mut llm = Llm::new("node-1".into(), config, Arc::clone(&registry));
        llm.set_event_sender(tx);

        llm.dispatch("trigger", ComponentValue::Bool(true)).unwrap();

        let events = drain_until_done(&mut rx, Duration::from_secs(2)).await;
        let err = events.iter().find(|e| e.source_handle.as_ref() == "error");
        assert!(err.is_some(), "expected error event, got {events:?}");
        if let Some(e) = err {
            if let ComponentValue::String(msg) = &e.value {
                assert!(msg.contains("missing"));
            } else {
                panic!("error event carried non-string value");
            }
        }
    }

    #[tokio::test]
    async fn forwards_system_prompt_when_set() {
        let registry = Arc::new(LlmRegistry::new());
        let recorder = Arc::new(RecordingLlmProvider::new());
        recorder.script_ok("ok");
        registry
            .insert("p".into(), recorder.clone() as Arc<dyn LlmProvider>)
            .await;

        let (tx, mut rx) = mpsc::unbounded_channel();
        let config = LlmConfig {
            provider_id: "p".into(),
            system: "you are terse".into(),
            prompt: "hi".into(),
            ..LlmConfig::default()
        };
        let mut llm = Llm::new("node-1".into(), config, Arc::clone(&registry));
        llm.set_event_sender(tx);

        llm.dispatch("trigger", ComponentValue::Bool(true)).unwrap();
        drain_until_done(&mut rx, Duration::from_secs(2)).await;

        let calls = recorder.recorded();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].system.as_deref(), Some("you are terse"));
    }

    #[tokio::test]
    async fn substitutes_template_vars_into_prompt() {
        let registry = Arc::new(LlmRegistry::new());
        let recorder = Arc::new(RecordingLlmProvider::new());
        recorder.script_ok("ok");
        registry
            .insert("p".into(), recorder.clone() as Arc<dyn LlmProvider>)
            .await;

        let (tx, mut rx) = mpsc::unbounded_channel();
        let config = LlmConfig {
            provider_id: "p".into(),
            prompt: "hello {{name}}".into(),
            ..LlmConfig::default()
        };
        let mut llm = Llm::new("node-1".into(), config, Arc::clone(&registry));
        llm.set_event_sender(tx);

        // Set the template var via the {{var}} input port.
        llm.dispatch("name", ComponentValue::String("world".into()))
            .unwrap();
        // Trigger the generation.
        llm.dispatch("trigger", ComponentValue::Bool(true)).unwrap();
        drain_until_done(&mut rx, Duration::from_secs(2)).await;

        let calls = recorder.recorded();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].prompt, "hello world");
    }
}
