//! LLM Component - External
//!
//! Calls an OpenAI-compatible LLM API (OpenRouter, Ollama, etc.)
//! and emits the text response downstream.
//!
//! # Handles
//!
//! - `trigger` (input): any incoming value starts generation
//! - `{{var}}` (input): dynamic prompt template variables
//! - `value` (output): emits the generated text response

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
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
}

impl Llm {
    #[must_use]
    pub fn new(id: String, config: LlmConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
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

    fn spawn_generate(&self, prompt: String) {
        let config = self.config.clone();
        let component_id = Arc::clone(&self.base.id);
        let event_sender = self.base.event_sender.clone();

        tokio::spawn(async move {
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

            log::info!("[Llm] {} → POST {url}", component_id);

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

                        if let Some(sender) = &event_sender {
                            let _ = sender.send(ComponentEvent {
                                source: Arc::clone(&component_id),
                                source_handle: Arc::from("value"),
                                value: ComponentValue::String(response),
                                edge_id: None,
                                sequence: 0,
                            });
                        }
                    }
                    Err(e) => log::error!("[Llm] {} failed to parse response: {e}", component_id),
                },
                Err(e) => log::error!("[Llm] {} request to {url} failed: {e}", component_id),
            }
        });
    }
}

impl Component for Llm {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Llm" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> {
        log::info!("[Llm] {} initialized: provider={}, model={}, base_url={}",
            self.base.id, self.config.provider, self.config.model, self.config.base_url);
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "trigger" => {
                // Signal thinking state to the frontend display
                self.base.emit_with_value("value", Cow::Owned(ComponentValue::Bool(true)));
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
