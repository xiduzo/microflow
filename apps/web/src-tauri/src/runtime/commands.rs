//! Tauri Commands for the Runtime
//!
//! `flow_update` and `component_call` commands

use super::base::ComponentValue;
use super::external::Figma;
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

/// Figma node info extracted from flow nodes
#[derive(Debug, Clone)]
struct FigmaNodeInfo {
    component_id: String,
    broker_id: String,
    unique_id: String,
    variable_id: String,
    resolved_type: String,
}

/// Extract Figma node info from flow nodes
fn extract_figma_nodes(flow: &FlowUpdate) -> Vec<FigmaNodeInfo> {
    flow.nodes
        .iter()
        .filter_map(|node| {
            // Accept either data.instance == "Figma" or the node's top-level type == "Figma"
            let instance = node.data.get("instance").and_then(|v| v.as_str())
                .or_else(|| node.node_type.as_deref())
                .unwrap_or("");
            if instance != "Figma" {
                return None;
            }
            let variable_id = node.data.get("variableId")?.as_str()?.to_string();
            if variable_id.is_empty() {
                return None;
            }
            Some(FigmaNodeInfo {
                component_id: node.id.clone(),
                broker_id: node.data.get("brokerId")?.as_str()?.to_string(),
                unique_id: node.data.get("uniqueId")?.as_str()?.to_string(),
                variable_id,
                resolved_type: node
                    .data
                    .get("resolvedType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("STRING")
                    .to_string(),
            })
        })
        .collect()
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
                retain: node.data.get("retain").and_then(serde_json::Value::as_bool).unwrap_or(false),
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
        brokers.as_ref().map_or(0, std::vec::Vec::len)
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

    // Extract MQTT and Figma nodes before applying flow
    let mqtt_nodes = extract_mqtt_nodes(&flow);
    let figma_nodes = extract_figma_nodes(&flow);
    log::info!("[MQTT] Found {} MQTT nodes in flow", mqtt_nodes.len());

    // Check if board is connected (only affects hardware init, not MQTT/Figma)
    let board_connected = *state.board_connected.read().unwrap();

    // Always apply the flow so components (Figma, Interval, etc.) are created
    // and MQTT subscriptions can be set up regardless of board connectivity.
    log::info!("Applying flow update to runtime (board_connected={board_connected})");
    {
        let mut runtime = state.flow_runtime.lock().await;
        runtime.update_flow(flow.clone())?;

        if board_connected {
            // Initialize hardware components (sets pin modes and enables analog/digital reporting)
            // This must be called after update_flow because update_flow destroys old components
            // (which call disable_analog_reporting) and creates new ones that need initialization.
            if let Err(e) = runtime.initialize_hardware() {
                log::warn!("Failed to initialize hardware after flow update: {e}");
            }

            // Reinstall pin change callback with updated listeners
            let event_tx = runtime.event_sender();
            runtime.install_pin_change_callback(event_tx);
        } else {
            // Store as pending so hardware init runs when the board connects later
            log::info!("Board not connected — storing pending flow for hardware init on connect");
            *state.pending_flow.write().unwrap() = Some(flow);
        }
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
                // Use try_lock() for async mutex in sync callback context
                // If lock is held, the message will be dropped (acceptable for MQTT)
                match flow_runtime.try_lock() {
                    Ok(mut runtime) => {
                        runtime.route_mqtt_message(&component_id, &msg.payload);
                    }
                    Err(_) => {
                        log::debug!("[MQTT] Flow runtime lock held, dropping message for {component_id}");
                    }
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

    // Set up MQTT subscriptions and initial publish for Figma nodes
    log::info!("[Figma] Found {} Figma nodes in flow", figma_nodes.len());
    for figma_node in figma_nodes {
        if figma_node.broker_id.is_empty() || figma_node.unique_id.is_empty() || figma_node.variable_id.is_empty() {
            log::warn!("[Figma] Skipping node {} — missing broker_id, unique_id, or variable_id", figma_node.component_id);
            continue;
        }

        if !state.mqtt_manager.is_connected(&figma_node.broker_id).await {
            log::warn!("[Figma] Broker {} not connected, skipping node {}", figma_node.broker_id, figma_node.component_id);
            continue;
        }

        // Build a temporary Figma instance just to get the topic strings
        let tmp = Figma::new(figma_node.component_id.clone(), super::external::FigmaConfig {
            broker_id: figma_node.broker_id.clone(),
            unique_id: figma_node.unique_id.clone(),
            variable_id: figma_node.variable_id.clone(),
            resolved_type: figma_node.resolved_type.clone(),
            debounce_time: 100,
        });
        let plugin_topic = tmp.plugin_variable_topic();
        let app_topic = tmp.app_variable_topic();

        // Subscribe to both topics (ongoing plugin updates + request/response)
        for sub_topic in [plugin_topic, app_topic] {
            let component_id = figma_node.component_id.clone();
            let flow_runtime = Arc::clone(&state.flow_runtime);
            let app_handle = app.clone();
            let t = sub_topic.clone();

            let callback = Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                log::info!("[Figma] Message on {} for component {}", msg.topic, component_id);
                match flow_runtime.try_lock() {
                    Ok(mut runtime) => {
                        runtime.route_figma_message(&component_id, &msg.topic, &msg.payload);
                    }
                    Err(_) => {
                        log::debug!("[Figma] Runtime lock held, dropping message for {component_id}");
                    }
                }
                let _ = app_handle.emit("mqtt-message", serde_json::json!({
                    "brokerId": "",
                    "topic": msg.topic,
                    "payload": String::from_utf8_lossy(&msg.payload).to_string(),
                    "componentId": component_id,
                }));
            });

            if let Err(e) = state.mqtt_manager.subscribe(&figma_node.broker_id, &t, callback).await {
                log::error!("[Figma] Failed to subscribe {}: {e}", t);
            }
        }

        // Publish app/status: connected (retained) so the plugin sees us
        let status_topic = format!("microflow/{}/app/status", figma_node.unique_id);
        if let Err(e) = state.mqtt_manager.publish(&figma_node.broker_id, &status_topic, b"connected", true).await {
            log::error!("[Figma] Failed to publish app/status: {e}");
        }

        // Request current variable values from the plugin
        let request_topic = format!("microflow/{}/app/variables/request", figma_node.unique_id);
        if let Err(e) = state.mqtt_manager.publish(&figma_node.broker_id, &request_topic, b"", false).await {
            log::error!("[Figma] Failed to publish variables/request: {e}");
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

    log::info!("Component call: {component_id}.{method}({value:?})");

    // Use async lock for tokio::sync::Mutex
    let mut runtime = state.flow_runtime.lock().await;
    runtime.call_component(&component_id, &method, value)
}
