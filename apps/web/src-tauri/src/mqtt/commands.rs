//! MQTT Tauri Commands
//!
//! Exposes MQTT functionality to the frontend via Tauri commands.

use super::broker::{BrokerConfig, ConnectionStatus, MqttMessage as BrokerMessage};
use crate::AppState;
use std::sync::Arc;
use tauri::{Emitter, State};

#[derive(Debug, Clone, serde::Serialize)]
pub struct MqttMessage {
    pub broker_id: String,
    pub topic: String,
    pub payload: String,
}

/// Broker status info returned to frontend
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrokerStatus {
    pub id: String,
    pub status: ConnectionStatus,
}

/// Broker config from frontend for sync
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SyncBrokerConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Connect to an MQTT broker
/// 
/// URL format: `protocol://host:port/path`
/// Supported protocols:
/// - `mqtt://` or `tcp://` - Plain TCP (default port 1883)
/// - `mqtts://` or `ssl://` - TLS (default port 8883)
/// - `ws://` - WebSocket (default port 80)
/// - `wss://` - WebSocket over TLS (default port 443)
#[tauri::command]
pub async fn mqtt_connect(
    state: State<'_, AppState>,
    broker_id: String,
    url: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let config = BrokerConfig {
        id: broker_id,
        url,
        username,
        password,
    };

    state.mqtt_manager.connect(config).await
}

/// Disconnect from an MQTT broker
#[tauri::command]
pub async fn mqtt_disconnect(state: State<'_, AppState>, broker_id: String) -> Result<(), String> {
    state.mqtt_manager.disconnect(&broker_id).await
}

/// Subscribe to a topic
#[tauri::command]
pub async fn mqtt_subscribe(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    broker_id: String,
    topic: String,
) -> Result<(), String> {
    let broker_id_clone = broker_id.clone();
    let app_handle = app.clone();

    let callback = Arc::new(move |msg: BrokerMessage| {
        let message = MqttMessage {
            broker_id: broker_id_clone.clone(),
            topic: msg.topic,
            payload: String::from_utf8_lossy(&msg.payload).to_string(),
        };
        let _ = app_handle.emit("mqtt-message", message);
    });

    state
        .mqtt_manager
        .subscribe(&broker_id, &topic, callback)
        .await
}

/// Unsubscribe from a topic
#[tauri::command]
pub async fn mqtt_unsubscribe(
    state: State<'_, AppState>,
    broker_id: String,
    topic: String,
) -> Result<(), String> {
    state.mqtt_manager.unsubscribe(&broker_id, &topic).await
}

/// Publish a message
#[tauri::command]
pub async fn mqtt_publish(
    state: State<'_, AppState>,
    broker_id: String,
    topic: String,
    payload: String,
    retain: Option<bool>,
) -> Result<(), String> {
    state
        .mqtt_manager
        .publish(&broker_id, &topic, payload.as_bytes(), retain.unwrap_or(false))
        .await
}

/// Get connection status
#[tauri::command]
pub async fn mqtt_status(state: State<'_, AppState>, broker_id: String) -> Result<String, String> {
    let status = state.mqtt_manager.status(&broker_id).await;
    Ok(format!("{status:?}"))
}

/// Get list of connected brokers
#[tauri::command]
pub async fn mqtt_connected_brokers(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.mqtt_manager.connected_brokers().await)
}

/// Sync all broker configs from frontend - connects to all brokers
/// This is called on app startup and whenever broker configs change
#[tauri::command]
pub async fn mqtt_sync_brokers(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    brokers: Vec<SyncBrokerConfig>,
) -> Result<Vec<BrokerStatus>, String> {
    log::info!("[MQTT] Syncing {} broker configs", brokers.len());
    
    // Get currently connected broker IDs
    let current_ids: std::collections::HashSet<String> = state
        .mqtt_manager
        .all_broker_ids()
        .await
        .into_iter()
        .collect();
    
    // Get new broker IDs
    let new_ids: std::collections::HashSet<String> = brokers.iter().map(|b| b.id.clone()).collect();
    
    // Disconnect brokers that were removed
    for id in current_ids.difference(&new_ids) {
        log::info!("[MQTT] Disconnecting removed broker: {id}");
        let _ = state.mqtt_manager.disconnect(id).await;
    }
    
    // Connect/update brokers
    for broker in &brokers {
        let config = BrokerConfig {
            id: broker.id.clone(),
            url: broker.url.clone(),
            username: broker.username.clone(),
            password: broker.password.clone(),
        };
        
        // Check if already connected with same config
        let current_status = state.mqtt_manager.status(&broker.id).await;
        
        if matches!(current_status, ConnectionStatus::Connected) {
            // Check if config changed - if so, reconnect
            if state.mqtt_manager.config_changed(&broker.id, &config).await {
                log::info!("[MQTT] Config changed for broker {}, reconnecting", broker.name);
                let _ = state.mqtt_manager.disconnect(&broker.id).await;
                if let Err(e) = state.mqtt_manager.connect(config).await {
                    log::error!("[MQTT] Failed to reconnect broker {}: {}", broker.name, e);
                }
            } else {
                log::debug!("[MQTT] Broker {} already connected with same config", broker.name);
            }
        } else {
            // Not connected, try to connect
            log::info!("[MQTT] Connecting to broker: {} ({})", broker.name, broker.url);
            if let Err(e) = state.mqtt_manager.connect(config).await {
                log::error!("[MQTT] Failed to connect to broker {}: {}", broker.name, e);
            }
        }
    }
    
    // Emit status update event
    let statuses = mqtt_all_statuses_inner(&state).await;
    let _ = app.emit("mqtt-broker-status", &statuses);
    
    Ok(statuses)
}

/// Get status of all known brokers
#[tauri::command]
pub async fn mqtt_all_statuses(state: State<'_, AppState>) -> Result<Vec<BrokerStatus>, String> {
    Ok(mqtt_all_statuses_inner(&state).await)
}

async fn mqtt_all_statuses_inner(state: &State<'_, AppState>) -> Vec<BrokerStatus> {
    state
        .mqtt_manager
        .all_statuses()
        .await
        .into_iter()
        .map(|(id, status)| BrokerStatus { id, status })
        .collect()
}
