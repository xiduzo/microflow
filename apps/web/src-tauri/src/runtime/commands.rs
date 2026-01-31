//! Tauri Commands for the Runtime
//!
//! flow_update and component_call commands

use super::base::ComponentValue;
use super::FlowUpdate;
use crate::AppState;
use crate::mqtt::broker::BrokerConfig;
use std::sync::Arc;
use tauri::Emitter;

/// Broker configuration from frontend
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FrontendBrokerConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// MQTT node info extracted from flow nodes
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct MqttNodeInfo {
    component_id: String,
    broker_id: String,
    topic: String,
    direction: String,
    retain: bool,
}

/// Extract MQTT node info from flow nodes
fn extract_mqtt_nodes(flow: &FlowUpdate) -> Vec<MqttNodeInfo> {
    flow.nodes
        .iter()
        .filter_map(|node| {
            let instance = node.data.get("instance")?.as_str()?;
            if instance != "Mqtt" {
                return None;
            }
            
            Some(MqttNodeInfo {
                component_id: node.id.clone(),
                broker_id: node.data.get("brokerId")?.as_str()?.to_string(),
                topic: node.data.get("topic")?.as_str()?.to_string(),
                direction: node.data.get("direction")?.as_str().unwrap_or("subscribe").to_string(),
                retain: node.data.get("retain").and_then(|v| v.as_bool()).unwrap_or(false),
            })
        })
        .collect()
}

/// Update the flow with new nodes and edges
#[tauri::command]
pub async fn flow_update(
    app: tauri::AppHandle,
    flow: FlowUpdate,
    brokers: Option<Vec<FrontendBrokerConfig>>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    log::info!(
        "=== FLOW UPDATE COMMAND === {} nodes, {} edges, {} brokers",
        flow.nodes.len(),
        flow.edges.len(),
        brokers.as_ref().map(|b| b.len()).unwrap_or(0)
    );

    // Auto-connect any brokers that are provided
    if let Some(broker_configs) = &brokers {
        for broker in broker_configs {
            log::info!("[MQTT] Auto-connecting broker: {} ({})", broker.name, broker.id);
            
            let config = BrokerConfig {
                id: broker.id.clone(),
                url: broker.url.clone(),
                username: broker.username.clone(),
                password: broker.password.clone(),
            };
            
            if let Err(e) = state.mqtt_manager.connect(config).await {
                log::error!("[MQTT] Failed to auto-connect broker {}: {}", broker.name, e);
            } else {
                log::info!("[MQTT] Successfully connected to broker: {}", broker.name);
            }
        }
    }

    // Extract MQTT nodes before applying flow
    let mqtt_nodes = extract_mqtt_nodes(&flow);
    log::info!("[MQTT] Found {} MQTT nodes in flow", mqtt_nodes.len());

    // Check if board is connected
    let board_connected = *state.board_connected.read().unwrap();
    
    if !board_connected {
        // Store as pending flow - will be applied when board connects
        log::info!("Board not connected, storing flow as pending");
        *state.pending_flow.write().unwrap() = Some(flow);
        return Ok(());
    }

    // Board is connected, apply flow immediately
    log::info!("Applying flow update to runtime");
    {
        let mut runtime = state.flow_runtime.lock()
            .map_err(|e| format!("Lock error: {:?}", e))?;
        runtime.update_flow(flow)?;
        
        // Reinstall pin change callback with updated listeners
        let event_tx = runtime.event_sender();
        runtime.install_pin_change_callback(event_tx);
    }

    // Set up MQTT subscriptions for subscribe nodes
    for mqtt_node in mqtt_nodes {
        if mqtt_node.direction == "subscribe" && !mqtt_node.broker_id.is_empty() && !mqtt_node.topic.is_empty() {
            log::info!(
                "[MQTT] Setting up subscription for component {} on broker {} topic {}",
                mqtt_node.component_id, mqtt_node.broker_id, mqtt_node.topic
            );

            // Check if broker is connected
            if !state.mqtt_manager.is_connected(&mqtt_node.broker_id).await {
                log::warn!(
                    "[MQTT] Broker {} not connected, skipping subscription for {}",
                    mqtt_node.broker_id, mqtt_node.component_id
                );
                continue;
            }

            // Create callback that routes messages to the flow runtime
            let component_id = mqtt_node.component_id.clone();
            let flow_runtime = Arc::clone(&state.flow_runtime);
            let app_handle = app.clone();

            let callback = Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                log::info!(
                    "[MQTT] Received message on topic {} for component {}",
                    msg.topic, component_id
                );

                // Route message to the flow component
                if let Ok(mut runtime) = flow_runtime.lock() {
                    runtime.route_mqtt_message(&component_id, &msg.payload);
                }

                // Also emit a Tauri event for the frontend
                let _ = app_handle.emit("mqtt-message", serde_json::json!({
                    "brokerId": "",
                    "topic": msg.topic,
                    "payload": String::from_utf8_lossy(&msg.payload).to_string(),
                    "componentId": component_id,
                }));
            });

            // Subscribe to the topic
            if let Err(e) = state.mqtt_manager.subscribe(
                &mqtt_node.broker_id,
                &mqtt_node.topic,
                callback,
            ).await {
                log::error!(
                    "[MQTT] Failed to subscribe component {} to {}: {}",
                    mqtt_node.component_id, mqtt_node.topic, e
                );
            }
        }
    }

    Ok(())
}

/// Call a method on a component
#[tauri::command]
pub async fn component_call(
    component_id: String,
    method: String,
    args: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let value = match args {
        serde_json::Value::Bool(b) => ComponentValue::Bool(b),
        serde_json::Value::Number(n) => ComponentValue::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => ComponentValue::String(s),
        _ => ComponentValue::default(),
    };

    log::info!("Component call: {}.{}({:?})", component_id, method, value);

    let mut runtime = state.flow_runtime.lock().unwrap();
    runtime.call_component(&component_id, &method, value)
}
