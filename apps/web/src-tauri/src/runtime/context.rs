//! Read-only bundle passed to component factories at construction time.
//!
//! Hands a component the registries / typed services it needs to talk to
//! the outside world. Today the bundle carries an [`LlmRegistry`]; in
//! Phase 4 of ADR-0002 this whole struct is replaced by a typed
//! `RuntimeServices` and per-impl `ComponentBuilder::Deps`.
//!
//! See `CONTEXT.md` § Runtime Context (deprecation note) and
//! `docs/adr/0002-per-capability-service-traits.md`.

use std::sync::Arc;

use super::services::LlmRegistry;

/// Construction-time bundle. Holds shared service registries via `Arc`
/// so live config rotation is visible to every component that already
/// holds a registry handle.
#[derive(Clone)]
pub struct RuntimeContext {
    /// Shared LLM provider registry. `Llm` resolves its `provider_id`
    /// against this at dispatch time — credential rotation takes effect
    /// on the next request without rebuilding the component.
    pub llm_registry: Arc<LlmRegistry>,
}

impl RuntimeContext {
    /// Build a context wrapping a freshly-allocated, empty [`LlmRegistry`].
    /// Most production call sites should clone an existing
    /// `Arc<LlmRegistry>` from `AppState` instead — use [`RuntimeContext::with_llm_registry`].
    #[must_use]
    pub fn empty() -> Self {
        Self {
            llm_registry: Arc::new(LlmRegistry::new()),
        }
    }

    /// Build a context around an existing shared registry.
    #[must_use]
    pub fn with_llm_registry(llm_registry: Arc<LlmRegistry>) -> Self {
        Self { llm_registry }
    }
}

impl Default for RuntimeContext {
    fn default() -> Self {
        Self::empty()
    }
}
