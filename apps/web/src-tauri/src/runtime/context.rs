//! Read-only bundle passed to component factories at construction time.
//!
//! Lets a component pluck external resources it needs (e.g. `Llm` reads its
//! provider's `base_url`/`api_key`) without mutating `node.data` upstream.
//! See `CONTEXT.md` § Runtime Context.

#[derive(Debug, Clone)]
pub struct ProviderEntry {
    pub id: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Default, Clone)]
pub struct RuntimeContext {
    pub providers: Vec<ProviderEntry>,
}

impl RuntimeContext {
    #[must_use]
    pub fn empty() -> Self { Self::default() }

    #[must_use]
    pub fn provider(&self, id: &str) -> Option<&ProviderEntry> {
        self.providers.iter().find(|p| p.id == id)
    }
}
