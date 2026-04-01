//! LLM Component - External
//!
//! Calls an `OpenAI`-compatible LLM API (`OpenRouter`, Ollama, etc.)
//! and emits the text response downstream.
//!
//! # Handles
//!
//! - `trigger` (input): any incoming value starts generation
//! - `{{var}}` (input): dynamic prompt template variables
//! - `thinking` (output, state): true while generating, false when idle
//! - `done` (output, event): fires when generation completes successfully
//! - `value` (output, value): emits the generated text response

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub system: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

fn default_provider() -> String { "ollama".to_string() }
fn default_base_url() -> String { "http://localhost:11434".to_string() }

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            model: String::new(),
            prompt: String::new(),
            system: String::new(),
            base_url: default_base_url(),
            api_key: String::new(),
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
}

impl Llm {
    #[must_use]
    pub fn new(id: String, config: LlmConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
            template_vars: HashMap::new(),
            rt_handle: tokio::runtime::Handle::try_current().ok(),
            running_task: None,
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

        let config = self.config.clone();
        let component_id = Arc::clone(&self.base.id);
        let event_sender = self.base.event_sender.clone();

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

            let base = config.base_url.trim_end_matches('/');
            let url = format!("{base}/v1/chat/completions");

            let mut messages = Vec::new();
            if !config.system.is_empty() {
                messages.push(serde_json::json!({ "role": "system", "content": config.system }));
            }
            messages.push(serde_json::json!({ "role": "user", "content": prompt }));

            let body = serde_json::json!({
                "model": config.model,
                "messages": messages,
                "stream": false,
            });

            let client = reqwest::Client::new();
            let mut req = client.post(&url).json(&body);
            if !config.api_key.is_empty() {
                req = req.bearer_auth(&config.api_key);
            }

            log::info!("[Llm] {component_id} → POST {url}");

            match req.send().await {
                Ok(resp) => match resp.json::<serde_json::Value>().await {
                    Ok(json) => {
                        let response = json
                            .get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("message"))
                            .and_then(|m| m.get("content"))
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();

                        log::info!("[Llm] {} response: {} chars", component_id, response.len());
                        send("thinking", ComponentValue::Bool(false));
                        send("value", ComponentValue::String(response));
                        send("done", ComponentValue::Bool(true));
                    }
                    Err(e) => {
                        log::error!("[Llm] {component_id} failed to parse response: {e}");
                        send("thinking", ComponentValue::Bool(false));
                        send("error", ComponentValue::String(e.to_string()));
                    }
                },
                Err(e) => {
                    log::error!("[Llm] {component_id} request to {url} failed: {e}");
                    send("thinking", ComponentValue::Bool(false));
                    send("error", ComponentValue::String(e.to_string()));
                }
            }
        });

        self.running_task = Some(join_handle.abort_handle());
    }
}

impl Component for Llm {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Llm" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        if self.rt_handle.is_none() {
            self.rt_handle = tokio::runtime::Handle::try_current().ok();
        }
        log::info!("[Llm] {} initialized: provider={}, model={}, base_url={}",
            self.base.id, self.config.provider, self.config.model, self.config.base_url);
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "trigger" => {
                // Signal thinking state on dedicated handle so UI updates immediately
                self.emit("thinking", ComponentValue::Bool(true));
                let prompt = self.build_prompt();
                self.spawn_generate(prompt);
            }
            var => {
                // Store dynamic template variable
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

    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> {
        self.base.event_sender.clone()
    }

    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) {
        self.base.event_sender = Some(sender);
    }

    fn requires_hardware(&self) -> bool { false }
}
