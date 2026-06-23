//! LLM Node config — shared by the live runtime and (future) codegen emitter.
//!
//! The structural fields that describe *what* this node generates (provider id,
//! model, prompt, system). Credentials/base-URL live on the host's provider
//! registry (desktop) or the browser's provider store, resolved when the request
//! is performed — never here.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    /// Human-facing provider kind label (`ollama`, `openrouter`, …). Surfaced in
    /// logs; not load-bearing for the runtime.
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Frontend provider record id; resolved against the host's registry when
    /// the request is performed.
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub system: String,
}

fn default_provider() -> String {
    "ollama".to_string()
}

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
