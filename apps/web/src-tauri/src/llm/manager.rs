//! LLM Provider Manager
//!
//! Stores provider configs keyed by ID. No persistent connections needed —
//! LLM calls are stateless HTTP requests resolved on demand.

use super::provider::ProviderConfig;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct LlmManager {
    providers: Arc<RwLock<HashMap<String, ProviderConfig>>>,
}

impl LlmManager {
    #[must_use]
    pub fn new() -> Self {
        Self {
            providers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Replace all providers with the new set (called on sync from frontend)
    pub async fn sync(&self, configs: Vec<ProviderConfig>) {
        let mut map = self.providers.write().await;
        map.clear();
        for config in configs {
            map.insert(config.id.clone(), config);
        }
        log::info!("[LLM] Synced {} provider(s)", map.len());
    }

    /// Retrieve a provider config by ID
    pub async fn get(&self, id: &str) -> Option<ProviderConfig> {
        self.providers.read().await.get(id).cloned()
    }
}

impl Default for LlmManager {
    fn default() -> Self {
        Self::new()
    }
}
