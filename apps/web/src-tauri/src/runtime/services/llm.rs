//! LLM **Capability Trait**, request/response value types, and the
//! `LlmRegistry` Service Registry.
//!
//! The trait is the seam: components depend on `Arc<dyn LlmProvider>` (or
//! on `Arc<LlmRegistry>` and resolve a provider by id at dispatch time),
//! never on `reqwest::Client` or a concrete endpoint.
//!
//! Two adapters ship with this module:
//!
//! - [`HttpLlmProvider`] — production. POSTs an OpenAI-compatible
//!   `/v1/chat/completions` request, parses `choices[0].message.content`.
//! - [`RecordingLlmProvider`] — test. Records every inbound [`LlmRequest`]
//!   and returns scripted [`LlmResponse`]s (or [`LlmError`]s). Mirrors the
//!   `TestIoLoop` adapter for `BoardHandle` (CONTEXT.md § TestIoLoop): two
//!   adapters is what makes the trait a real seam, not a hypothetical one.
//!
//! See `docs/adr/0002-per-capability-service-traits.md`.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::sync::RwLock;

/// A single LLM completion request. The OpenAI-compatible shape — `system`
/// is optional because some providers (e.g. local Ollama models without a
/// system slot) ignore it; callers that don't have a system prompt pass
/// `None` rather than an empty string so the request shape matches the
/// provider's expectation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmRequest {
    /// Model id understood by the provider (`gpt-4o-mini`,
    /// `llama3.1:8b`, `claude-opus-4-7`, …). Opaque to the trait.
    pub model: String,
    /// Optional system prompt prepended to the message list.
    pub system: Option<String>,
    /// User-role prompt content. Template substitution already applied by
    /// the caller (the `Llm` component owns `{{var}}` resolution; the
    /// provider sees the rendered string).
    pub prompt: String,
}

/// A single LLM completion response.
///
/// Only the assistant text is exposed for now. Token counts, finish reasons,
/// and stop sequences are not part of the trait surface yet — they accrete
/// when the first consumer needs them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmResponse {
    pub text: String,
}

/// Failure modes a `LlmProvider::generate` can surface.
///
/// Distinct from [`crate::error::RuntimeError`] so a component can match on
/// the specific failure (cancelled vs. provider missing vs. wire failure)
/// without growing a `RuntimeError` variant per external kind.
#[derive(Error, Debug)]
pub enum LlmError {
    /// Caller asked the [`LlmRegistry`] for a provider id that isn't present.
    #[error("LLM provider '{0}' not found")]
    ProviderNotFound(String),

    /// HTTP transport failure (DNS, TLS handshake, connection refused,
    /// timeout, non-2xx status). Inner message is the upstream reason.
    #[error("LLM request failed: {0}")]
    Request(String),

    /// Response body didn't deserialize, or didn't contain the expected
    /// `choices[0].message.content` path.
    #[error("LLM response parse failed: {0}")]
    Parse(String),

    /// The `RecordingLlmProvider` script was exhausted, or the production
    /// task was aborted before the wire returned. Distinct from `Request`
    /// so tests can assert on cancellation paths without matching on a
    /// transport error message.
    #[error("LLM request cancelled")]
    Cancelled,
}

/// Capability Trait for any backend that can run an LLM completion.
///
/// Implementations must be `Send + Sync` because `Arc<dyn LlmProvider>` is
/// shared across tokio tasks. Async via `async-trait` to keep the trait
/// object-safe under Rust 2021.
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Run one completion request. Cancellation is the caller's job — the
    /// provider does not own the task; if the caller drops the awaiting
    /// future the in-flight request is abandoned at the next `.await`.
    async fn generate(&self, request: LlmRequest) -> Result<LlmResponse, LlmError>;
}

// ---------------------------------------------------------------------------
// Production: HttpLlmProvider
// ---------------------------------------------------------------------------

/// Production [`LlmProvider`] backed by an OpenAI-compatible
/// `/v1/chat/completions` endpoint (`OpenAI`, `OpenRouter`, Ollama with
/// `/v1` enabled, vLLM, LM Studio, …).
///
/// One instance per provider id — `base_url`+`api_key` are immutable on
/// the instance. Credential rotation = a new `HttpLlmProvider` inserted
/// into [`LlmRegistry`] under the same id. The `reqwest::Client` is shared
/// across calls so the connection pool is reused.
pub struct HttpLlmProvider {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
}

impl HttpLlmProvider {
    /// Build a provider against the given endpoint. `base_url` may include
    /// or omit a trailing slash; the `/v1/chat/completions` suffix is
    /// appended at request time. Empty `api_key` skips the
    /// `Authorization: Bearer` header (useful for local Ollama).
    #[must_use]
    pub fn new(base_url: String, api_key: String) -> Self {
        Self {
            base_url,
            api_key,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl LlmProvider for HttpLlmProvider {
    async fn generate(&self, request: LlmRequest) -> Result<LlmResponse, LlmError> {
        let base = self.base_url.trim_end_matches('/');
        let url = format!("{base}/v1/chat/completions");

        let mut messages = Vec::with_capacity(2);
        if let Some(system) = &request.system {
            if !system.is_empty() {
                messages.push(serde_json::json!({ "role": "system", "content": system }));
            }
        }
        messages.push(serde_json::json!({ "role": "user", "content": request.prompt }));

        let body = serde_json::json!({
            "model": request.model,
            "messages": messages,
            "stream": false,
        });

        let mut req = self.client.post(&url).json(&body);
        if !self.api_key.is_empty() {
            req = req.bearer_auth(&self.api_key);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| LlmError::Request(e.to_string()))?;

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| LlmError::Parse(e.to_string()))?;

        let text = json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|s| s.as_str())
            .ok_or_else(|| {
                LlmError::Parse(format!(
                    "missing choices[0].message.content in response: {json}"
                ))
            })?
            .to_string();

        Ok(LlmResponse { text })
    }
}

// ---------------------------------------------------------------------------
// Test: RecordingLlmProvider
// ---------------------------------------------------------------------------

/// Test [`LlmProvider`] that records every inbound request and returns
/// scripted outcomes from a FIFO queue.
///
/// Mirrors the recording-test-double pattern: tests assert what was sent and
/// drive the component through both success and failure
/// paths without standing up an LLM endpoint. The second adapter beside
/// [`HttpLlmProvider`] is what makes [`LlmProvider`] a real seam.
///
/// Behavioural contract:
///
/// - `generate` pops the *front* of `scripted` and returns it; if empty,
///   returns [`LlmError::Cancelled`] so misconfigured tests fail loudly
///   rather than blocking on a fake await.
/// - `recorded` returns a snapshot of all requests received so far, in
///   call order.
pub struct RecordingLlmProvider {
    recorded: Mutex<Vec<LlmRequest>>,
    scripted: Mutex<std::collections::VecDeque<Result<LlmResponse, LlmError>>>,
}

impl RecordingLlmProvider {
    #[must_use]
    pub fn new() -> Self {
        Self {
            recorded: Mutex::new(Vec::new()),
            scripted: Mutex::new(std::collections::VecDeque::new()),
        }
    }

    /// Push one scripted outcome onto the back of the queue. Calls consume
    /// from the front.
    pub fn script(&self, outcome: Result<LlmResponse, LlmError>) {
        self.scripted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push_back(outcome);
    }

    /// Convenience: script a successful text reply.
    pub fn script_ok(&self, text: impl Into<String>) {
        self.script(Ok(LlmResponse { text: text.into() }));
    }

    /// Snapshot of every request received, in call order.
    #[must_use]
    pub fn recorded(&self) -> Vec<LlmRequest> {
        self.recorded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl Default for RecordingLlmProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl LlmProvider for RecordingLlmProvider {
    async fn generate(&self, request: LlmRequest) -> Result<LlmResponse, LlmError> {
        self.recorded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(request);
        self.scripted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop_front()
            .unwrap_or(Err(LlmError::Cancelled))
    }
}

// ---------------------------------------------------------------------------
// LlmRegistry
// ---------------------------------------------------------------------------

/// Live registry of [`LlmProvider`] implementations keyed by provider id.
///
/// Replaces the parallel `LlmManager` + `RuntimeContext.providers` dual
/// state (ADR-0002). Components hold `Arc<LlmRegistry>` and call
/// [`LlmRegistry::get`] per dispatch, so swapping a provider's
/// `base_url`/`api_key` (via [`LlmRegistry::sync`]) takes effect on the
/// next request — no component rebuild required.
///
/// Internal storage is `tokio::sync::RwLock<HashMap<...>>` so syncs and
/// reads coexist with async tasks holding open generate calls.
pub struct LlmRegistry {
    entries: RwLock<HashMap<String, Arc<dyn LlmProvider>>>,
}

impl LlmRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
        }
    }

    /// Insert or replace one entry. Existing in-flight calls against the
    /// previous instance continue to completion; subsequent lookups see the
    /// new one.
    pub async fn insert(&self, id: String, provider: Arc<dyn LlmProvider>) {
        self.entries.write().await.insert(id, provider);
    }

    /// Resolve an entry by id.
    pub async fn get(&self, id: &str) -> Option<Arc<dyn LlmProvider>> {
        self.entries.read().await.get(id).cloned()
    }

    /// Replace the entire registry atomically. Used by the frontend sync
    /// path: the frontend's authoritative provider list is pushed in full,
    /// so atomic replace gives "the set you sent is what's live."
    pub async fn sync(&self, providers: Vec<(String, Arc<dyn LlmProvider>)>) {
        let mut map = self.entries.write().await;
        map.clear();
        for (id, provider) in providers {
            map.insert(id, provider);
        }
    }

    /// Snapshot of all currently registered provider ids. Order is
    /// undefined (`HashMap` iteration). Mostly useful for tests and logging.
    pub async fn ids(&self) -> Vec<String> {
        self.entries.read().await.keys().cloned().collect()
    }
}

impl Default for LlmRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn recording_provider_records_request_and_returns_scripted_response() {
        let provider = RecordingLlmProvider::new();
        provider.script_ok("hello back");

        let resp = provider
            .generate(LlmRequest {
                model: "test-model".into(),
                system: Some("be terse".into()),
                prompt: "hi".into(),
            })
            .await
            .expect("scripted ok");

        assert_eq!(resp.text, "hello back");

        let recorded = provider.recorded();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].model, "test-model");
        assert_eq!(recorded[0].system.as_deref(), Some("be terse"));
        assert_eq!(recorded[0].prompt, "hi");
    }

    #[tokio::test]
    async fn recording_provider_returns_cancelled_when_script_empty() {
        let provider = RecordingLlmProvider::new();
        let err = provider
            .generate(LlmRequest {
                model: "m".into(),
                system: None,
                prompt: "p".into(),
            })
            .await
            .expect_err("script exhausted");
        assert!(matches!(err, LlmError::Cancelled));
    }

    #[tokio::test]
    async fn recording_provider_returns_scripted_errors() {
        let provider = RecordingLlmProvider::new();
        provider.script(Err(LlmError::Request("boom".into())));
        let err = provider
            .generate(LlmRequest {
                model: "m".into(),
                system: None,
                prompt: "p".into(),
            })
            .await
            .expect_err("scripted err");
        assert!(matches!(err, LlmError::Request(msg) if msg == "boom"));
    }

    #[tokio::test]
    async fn recording_provider_scripts_drain_fifo() {
        let provider = RecordingLlmProvider::new();
        provider.script_ok("first");
        provider.script_ok("second");

        let req = LlmRequest {
            model: "m".into(),
            system: None,
            prompt: "p".into(),
        };
        let a = provider.generate(req.clone()).await.unwrap();
        let b = provider.generate(req).await.unwrap();
        assert_eq!(a.text, "first");
        assert_eq!(b.text, "second");
    }

    #[tokio::test]
    async fn registry_insert_and_get_roundtrip() {
        let registry = LlmRegistry::new();
        let provider = Arc::new(RecordingLlmProvider::new());
        provider.script_ok("ok");

        registry
            .insert("alpha".into(), provider.clone() as Arc<dyn LlmProvider>)
            .await;

        let fetched = registry.get("alpha").await.expect("present");
        let resp = fetched
            .generate(LlmRequest {
                model: "m".into(),
                system: None,
                prompt: "p".into(),
            })
            .await
            .expect("ok");
        assert_eq!(resp.text, "ok");
        // Original handle should also see the recorded request.
        assert_eq!(provider.recorded().len(), 1);
    }

    #[tokio::test]
    async fn registry_get_missing_returns_none() {
        let registry = LlmRegistry::new();
        assert!(registry.get("nope").await.is_none());
    }

    #[tokio::test]
    async fn registry_sync_replaces_all_entries_atomically() {
        let registry = LlmRegistry::new();

        let a = Arc::new(RecordingLlmProvider::new()) as Arc<dyn LlmProvider>;
        let b = Arc::new(RecordingLlmProvider::new()) as Arc<dyn LlmProvider>;
        registry.insert("a".into(), a).await;
        registry.insert("b".into(), b).await;
        assert_eq!(registry.ids().await.len(), 2);

        let c = Arc::new(RecordingLlmProvider::new()) as Arc<dyn LlmProvider>;
        registry.sync(vec![("c".into(), c)]).await;

        let ids = registry.ids().await;
        assert_eq!(ids, vec!["c".to_string()]);
        assert!(registry.get("a").await.is_none());
        assert!(registry.get("b").await.is_none());
        assert!(registry.get("c").await.is_some());
    }

    #[tokio::test]
    async fn registry_insert_replaces_same_id() {
        let registry = LlmRegistry::new();
        let first = Arc::new(RecordingLlmProvider::new());
        first.script_ok("from-first");
        let second = Arc::new(RecordingLlmProvider::new());
        second.script_ok("from-second");

        registry
            .insert("id".into(), first.clone() as Arc<dyn LlmProvider>)
            .await;
        registry
            .insert("id".into(), second.clone() as Arc<dyn LlmProvider>)
            .await;

        let fetched = registry.get("id").await.expect("present");
        let resp = fetched
            .generate(LlmRequest {
                model: "m".into(),
                system: None,
                prompt: "p".into(),
            })
            .await
            .unwrap();
        assert_eq!(resp.text, "from-second");
        assert!(first.recorded().is_empty());
        assert_eq!(second.recorded().len(), 1);
    }
}
