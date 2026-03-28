//! Tauri commands for LLM provider management

use super::provider::ProviderConfig;
use crate::AppState;
use tauri::State;

/// Provider config payload from the frontend
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SyncProviderConfig {
    pub id: String,
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
    let configs: Vec<ProviderConfig> = providers
        .into_iter()
        .map(|p| ProviderConfig {
            id: p.id,
            name: p.name,
            base_url: p.base_url,
            api_key: p.api_key,
        })
        .collect();

    state.llm_manager.sync(configs).await;
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
