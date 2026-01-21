//! MQTT Tauri Commands
//!
//! Exposes MQTT functionality to the frontend via Tauri commands.

use super::broker::{BrokerConfig, MqttMessage as BrokerMessage};
use crate::AppState;
use std::sync::Arc;
use tauri::{Emitter, State};

#[derive(Debug, Clone, serde::Serialize)]
pub struct MqttMessage {
    pub broker_id: String,
    pub topic: String,
    pub payload: String,
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
    Ok(format!("{:?}", status))
}

/// Get list of connected brokers
#[tauri::command]
pub async fn mqtt_connected_brokers(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.mqtt_manager.connected_brokers().await)
}
