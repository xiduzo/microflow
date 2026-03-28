//! LLM Provider configuration

use serde::{Deserialize, Serialize};

/// A configured LLM provider (OpenRouter, Ollama, OpenAI-compatible endpoint, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    /// Base URL — e.g. `http://localhost:11434` or `https://openrouter.ai/api/v1`
    pub base_url: String,
    /// API key — empty for local Ollama, required for OpenRouter / OpenAI
    pub api_key: String,
}
