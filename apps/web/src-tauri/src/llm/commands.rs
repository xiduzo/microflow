//! Tauri commands for LLM provider management.
//!
//! `llm_sync_providers` is the frontend's primary sync path: it pushes the
//! authoritative list of provider records straight into the shared
//! [`crate::runtime::services::LlmRegistry`] held on [`crate::AppState`].
//! Once synced, every live `Llm` component sees the new credentials on its
//! next `dispatch("trigger")` — no `flow_update` re-fire required (ADR-0002).

use crate::runtime::services::{HttpLlmProvider, LlmProvider};
use crate::AppState;
use std::sync::Arc;
use tauri::State;

/// Provider config payload from the frontend
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SyncProviderConfig {
    pub id: String,
    #[allow(dead_code)]
    pub name: String,
    pub base_url: String,
    pub api_key: String,
}

/// Sync all provider configs from the frontend.
/// Called on startup and whenever configs change.
#[tauri::command]
pub async fn llm_sync_providers(
    state: State<'_, AppState>,
    providers: Vec<SyncProviderConfig>,
) -> Result<(), String> {
    let count = providers.len();
    let entries: Vec<(String, Arc<dyn LlmProvider>)> = providers
        .into_iter()
        .map(|p| {
            let provider: Arc<dyn LlmProvider> =
                Arc::new(HttpLlmProvider::new(p.base_url, p.api_key));
            (p.id, provider)
        })
        .collect();

    state.llm_registry.sync(entries).await;
    log::info!("[LLM] Synced {count} provider(s) into registry");
    Ok(())
}

/// Test a provider by fetching the models list.
/// Returns "ok" on success or an error message.
#[tauri::command]
pub async fn llm_test_provider(
    base_url: String,
    api_key: String,
) -> Result<(), String> {
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&url);
    if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }

    let resp = req.send().await.map_err(|e| format!("Connection failed: {e}"))?;
    let status = resp.status();

    if status.is_success() {
        Ok(())
    } else {
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        let text = resp.text().await.unwrap_or_default();

        // Try to extract a human-readable message from JSON error responses
        if content_type.contains("application/json") {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                let msg = json
                    .get("error")
                    .and_then(|e| e.get("message").or(Some(e)))
                    .and_then(|v| v.as_str())
                    .or_else(|| json.get("message").and_then(|v| v.as_str()));
                if let Some(msg) = msg {
                    return Err(format!("HTTP {status}: {msg}"));
                }
            }
        }

        Err(format!("HTTP {status}: {}", status.canonical_reason().unwrap_or("Unknown error")))
    }
}
