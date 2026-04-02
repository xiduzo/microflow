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

/// LLM provider configuration from frontend
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FrontendProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
}

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
                .or(node.node_type.as_deref())
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

/// Collect `unique_ids` from Figma nodes to determine which display topics to manage
fn collect_figma_unique_ids(figma_nodes: &[FigmaNodeInfo]) -> std::collections::HashMap<String, String> {
    // Map unique_id -> broker_id (one broker per unique_id)
    let mut map = std::collections::HashMap::new();
    for node in figma_nodes {
        if !node.unique_id.is_empty() && !node.broker_id.is_empty() {
            map.entry(node.unique_id.clone()).or_insert_with(|| node.broker_id.clone());
        }
    }
    map
}

/// Update the flow with new nodes and edges
#[tauri::command]
pub async fn flow_update(
    app: tauri::AppHandle,
    mut flow: FlowUpdate,
    brokers: Option<Vec<FrontendBrokerConfig>>,
    providers: Option<Vec<FrontendProviderConfig>>,
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

    // Inject LLM provider config into LLM nodes
    if let Some(ref provider_configs) = providers {
        let provider_map: std::collections::HashMap<&str, &FrontendProviderConfig> =
            provider_configs.iter().map(|p| (p.id.as_str(), p)).collect();
        for node in &mut flow.nodes {
            let instance = node.data.get("instance").and_then(|v| v.as_str()).unwrap_or("");
            if instance == "Llm" {
                let provider_id = node.data.get("providerId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if let Some(p) = provider_map.get(provider_id.as_str()) {
                    if let Some(obj) = node.data.as_object_mut() {
                        obj.insert("baseUrl".to_string(), serde_json::Value::String(p.base_url.clone()));
                        obj.insert("apiKey".to_string(), serde_json::Value::String(p.api_key.clone()));
                    }
                }
            }
        }
    }

    // Extract MQTT and Figma nodes before applying flow
    let mqtt_nodes = extract_mqtt_nodes(&flow);
    let figma_nodes = extract_figma_nodes(&flow);
    log::info!("[MQTT] Found {} MQTT nodes in flow", mqtt_nodes.len());

    // ---- Clean up previous Figma subscriptions ----
    {
        let mut old_subs = state.figma_subscriptions.lock().await;

        // Collect unique_ids from old subs to publish disconnected status
        let mut old_unique_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for sub in old_subs.iter() {
            // Extract unique_id from topics like "microflow/{unique_id}/figma/..."
            let parts: Vec<&str> = sub.topic.split('/').collect();
            if parts.len() >= 3 && parts[0] == "microflow" {
                old_unique_ids.entry(parts[1].to_string()).or_insert_with(|| sub.broker_id.clone());
            }
        }

        // Publish disconnected status for old unique_ids that won't be in the new flow
        let new_unique_ids = collect_figma_unique_ids(&figma_nodes);
        for (uid, broker_id) in &old_unique_ids {
            if !new_unique_ids.contains_key(uid) {
                let status_topic = format!("microflow/{uid}/app/status");
                let _ = state.mqtt_manager.publish(broker_id, &status_topic, b"disconnected", true).await;
                log::info!("[Figma] Published disconnected status for {uid}");
            }
        }

        for sub in old_subs.drain(..) {
            log::info!("[Figma] Unsubscribing old topic: {} on broker {}", sub.topic, sub.broker_id);
            if let Err(e) = state.mqtt_manager.unsubscribe(&sub.broker_id, &sub.topic).await {
                log::warn!("[Figma] Failed to unsubscribe {}: {}", sub.topic, e);
            }
        }
    }

    // Check if board is connected (only affects hardware init, not MQTT/Figma)
    let board_connected = *state.board_connected.read().unwrap_or_else(std::sync::PoisonError::into_inner);

    // Always apply the flow so components (Figma, Interval, etc.) are created
    // and MQTT subscriptions can be set up regardless of board connectivity.
    log::info!("Applying flow update to runtime (board_connected={board_connected})");
    {
        let mut runtime = state.flow_runtime.lock().await;
        runtime.update_flow(flow.clone())?;

        if board_connected {
            if let Err(e) = runtime.initialize_hardware() {
                log::warn!("Failed to initialize hardware after flow update: {e}");
            }
            let event_tx = runtime.event_sender();
            runtime.install_pin_change_callback(event_tx);
        } else {
            log::info!("Board not connected — storing pending flow for hardware init on connect");
            *state.pending_flow.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(flow);
        }
    }

    // Set up MQTT subscriptions for subscribe nodes
    for mqtt_node in mqtt_nodes {
        if mqtt_node.direction == "subscribe" && !mqtt_node.broker_id.is_empty() && !mqtt_node.topic.is_empty() {
            log::info!(
                "[MQTT] Setting up subscription for component {} on broker {} topic {}",
                mqtt_node.component_id, mqtt_node.broker_id, mqtt_node.topic
            );

            if !state.mqtt_manager.is_connected(&mqtt_node.broker_id).await {
                log::warn!(
                    "[MQTT] Broker {} not connected, skipping subscription for {}",
                    mqtt_node.broker_id, mqtt_node.component_id
                );
                continue;
            }

            let component_id = mqtt_node.component_id.clone();
            let flow_runtime = Arc::clone(&state.flow_runtime);
            let app_handle = app.clone();

            let callback = Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                log::info!(
                    "[MQTT] Received message on topic {} for component {}",
                    msg.topic, component_id
                );
                match flow_runtime.try_lock() {
                    Ok(mut runtime) => {
                        runtime.route_mqtt_message(&component_id, &msg.payload);
                    }
                    Err(_) => {
                        log::debug!("[MQTT] Flow runtime lock held, dropping message for {component_id}");
                    }
                }
                let _ = app_handle.emit("mqtt-message", serde_json::json!({
                    "brokerId": "",
                    "topic": msg.topic,
                    "payload": String::from_utf8_lossy(&msg.payload).to_string(),
                    "componentId": component_id,
                }));
            });

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

    // ---- Set up Figma MQTT subscriptions (per-variable + display topics) ----
    let mut new_subs: Vec<crate::FigmaSubscription> = Vec::new();
    let unique_id_brokers = collect_figma_unique_ids(&figma_nodes);

    log::info!("[Figma] Found {} Figma nodes in flow, {} unique users", figma_nodes.len(), unique_id_brokers.len());

    // 1. Subscribe to per-variable topics (route to flow runtime)
    for figma_node in &figma_nodes {
        if figma_node.broker_id.is_empty() || figma_node.unique_id.is_empty() || figma_node.variable_id.is_empty() {
            log::warn!("[Figma] Skipping node {} — missing broker_id, unique_id, or variable_id", figma_node.component_id);
            continue;
        }

        if !state.mqtt_manager.is_connected(&figma_node.broker_id).await {
            log::warn!("[Figma] Broker {} not connected, skipping node {}", figma_node.broker_id, figma_node.component_id);
            continue;
        }

        let tmp = Figma::new(figma_node.component_id.clone(), super::external::FigmaConfig {
            broker_id: figma_node.broker_id.clone(),
            unique_id: figma_node.unique_id.clone(),
            variable_id: figma_node.variable_id.clone(),
            resolved_type: figma_node.resolved_type.clone(),
            debounce_time: 100,
        });
        let plugin_topic = tmp.plugin_variable_topic();
        let app_topic = tmp.app_variable_topic();

        for sub_topic in [plugin_topic, app_topic] {
            let component_id = figma_node.component_id.clone();
            let flow_runtime = Arc::clone(&state.flow_runtime);
            let app_handle = app.clone();

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

            if let Err(e) = state.mqtt_manager.subscribe(&figma_node.broker_id, &sub_topic, callback).await {
                log::error!("[Figma] Failed to subscribe {sub_topic}: {e}");
            }
            new_subs.push(crate::FigmaSubscription {
                broker_id: figma_node.broker_id.clone(),
                topic: sub_topic,
            });
        }
    }

    // 2. Subscribe to display topics (variables list, plugin status) per unique_id
    //    and emit Tauri events so the frontend store stays updated.
    for (unique_id, broker_id) in &unique_id_brokers {
        if !state.mqtt_manager.is_connected(broker_id).await {
            continue;
        }

        let display_topics = vec![
            format!("microflow/{unique_id}/figma/variables"),
            format!("microflow/{unique_id}/figma/status"),
            format!("microflow/{unique_id}/app/variables/response"),
        ];

        for topic in display_topics {
            let app_handle = app.clone();
            let callback = Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                let _ = app_handle.emit("mqtt-message", serde_json::json!({
                    "brokerId": "",
                    "topic": msg.topic,
                    "payload": String::from_utf8_lossy(&msg.payload).to_string(),
                }));
            });

            if let Err(e) = state.mqtt_manager.subscribe(broker_id, &topic, callback).await {
                log::error!("[Figma] Failed to subscribe display topic {topic}: {e}");
            }
            new_subs.push(crate::FigmaSubscription {
                broker_id: broker_id.clone(),
                topic,
            });
        }

        // Publish app/status: connected (retained) so the plugin sees us
        let status_topic = format!("microflow/{unique_id}/app/status");
        if let Err(e) = state.mqtt_manager.publish(broker_id, &status_topic, b"connected", true).await {
            log::error!("[Figma] Failed to publish app/status: {e}");
        }

        // Request current variable values from the plugin
        let request_topic = format!("microflow/{unique_id}/app/variables/request");
        if let Err(e) = state.mqtt_manager.publish(broker_id, &request_topic, b"", false).await {
            log::error!("[Figma] Failed to publish variables/request: {e}");
        }
    }

    // Store new subscriptions for cleanup on next flow_update
    {
        let mut subs = state.figma_subscriptions.lock().await;
        *subs = new_subs;
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

    let mut runtime = state.flow_runtime.lock().await;
    Ok(runtime.call_component(&component_id, &method, value)?)
}
