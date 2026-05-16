//! Tauri Commands for the Runtime
//!
//! `flow_update` and `component_call` commands

use super::base::ComponentValue;
use super::context::RuntimeContext;
use super::services::{HttpLlmProvider, LlmProvider};
use super::wiring::SubscriberWiring;
use super::FlowUpdate;
use crate::AppState;
use crate::mqtt::broker::BrokerConfig;
use std::collections::{HashMap, HashSet};
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

/// Extract the Figma `unique_id` from a `microflow/{uid}/...` topic.
fn microflow_uid(topic: &str) -> Option<&str> {
    let mut parts = topic.split('/');
    if parts.next()? != "microflow" { return None; }
    parts.next().filter(|s| !s.is_empty())
}

/// Update the flow with new nodes and edges
#[tauri::command]
pub async fn flow_update(
    app: tauri::AppHandle,
    flow: FlowUpdate,
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

    // Sync any provider records straight into the shared LlmRegistry so
    // components built by this flow_update — and any subsequent
    // `Llm::dispatch("trigger")` — see live credentials. This replaces the
    // legacy build-time snapshot into `LlmConfig.base_url/api_key`. See
    // ADR-0002 § Decision D2.
    if let Some(provider_configs) = providers {
        let entries: Vec<(String, Arc<dyn LlmProvider>)> = provider_configs
            .into_iter()
            .map(|p| {
                let provider: Arc<dyn LlmProvider> =
                    Arc::new(HttpLlmProvider::new(p.base_url, p.api_key));
                (p.id, provider)
            })
            .collect();
        state.llm_registry.sync(entries).await;
    }

    // RuntimeContext for component factories. Components that need an
    // LlmRegistry clone the `Arc` out of `ctx` at build time and resolve
    // providers at dispatch time.
    let ctx = RuntimeContext::with_llm_registry(Arc::clone(&state.llm_registry));

    // Apply the flow first so components are constructed and can describe their wiring.
    let board_connected = *state.board_connected.read().unwrap_or_else(std::sync::PoisonError::into_inner);
    log::info!("Applying flow update to runtime (board_connected={board_connected})");

    let component_wirings: Vec<(String, SubscriberWiring)> = {
        let mut runtime = state.flow_runtime.lock().await;
        runtime.update_flow(flow.clone(), &ctx)?;

        if board_connected {
            if let Err(e) = runtime.initialize_hardware() {
                log::warn!("Failed to initialize hardware after flow update: {e}");
            }
            // Pin-change and I2C-reply callbacks are installed once at
            // FlowRuntime::new(); they observe live wiring updates via the
            // shared `WiringRegistry` indices. Nothing to reinstall here.
        } else {
            log::info!("Board not connected — storing pending flow for hardware init on connect");
            *state.pending_flow.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((flow, ctx.clone()));
        }

        runtime.collect_subscriber_wirings()
    };

    // Derive the new set of Figma unique_ids from any `microflow/{uid}/...` topics
    // appearing in the wirings (Plain, TopicAware, or DisplayEcho).
    let new_unique_ids: HashMap<String, String> = component_wirings.iter()
        .filter_map(|(_, w)| {
            microflow_uid(w.topic()).map(|uid| (uid.to_string(), w.broker_id().to_string()))
        })
        .collect();

    // Cleanup previous subscriptions: publish disconnect for vanished uids, then unsubscribe.
    {
        let mut old_subs = state.figma_subscriptions.lock().await;

        let mut old_unique_ids: HashMap<String, String> = HashMap::new();
        for sub in old_subs.iter() {
            if let Some(uid) = microflow_uid(&sub.topic) {
                old_unique_ids.entry(uid.to_string()).or_insert_with(|| sub.broker_id.clone());
            }
        }

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

    // Subscribe new wirings, deduping DisplayEcho on (broker_id, topic).
    let mut new_subs: Vec<crate::FigmaSubscription> = Vec::new();
    let mut display_echo_seen: HashSet<(String, String)> = HashSet::new();

    for (component_id, wiring) in &component_wirings {
        let broker_id = wiring.broker_id().to_string();
        let topic = wiring.topic().to_string();

        if !state.mqtt_manager.is_connected(&broker_id).await {
            log::warn!("[MQTT] Broker {broker_id} not connected, skipping subscription for {component_id}");
            continue;
        }

        let callback: Arc<dyn Fn(crate::mqtt::broker::MqttMessage) + Send + Sync> = match wiring {
            SubscriberWiring::Plain { .. } => {
                let component_id = component_id.clone();
                let flow_runtime = Arc::clone(&state.flow_runtime);
                let app_handle = app.clone();
                Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                    log::info!("[MQTT] Received message on topic {} for component {}", msg.topic, component_id);
                    match flow_runtime.try_lock() {
                        Ok(mut runtime) => runtime.route_mqtt_message(&component_id, &msg.payload),
                        Err(_) => log::debug!("[MQTT] Flow runtime lock held, dropping message for {component_id}"),
                    }
                    let _ = app_handle.emit("mqtt-message", serde_json::json!({
                        "brokerId": "",
                        "topic": msg.topic,
                        "payload": String::from_utf8_lossy(&msg.payload).to_string(),
                        "componentId": component_id,
                    }));
                })
            }
            SubscriberWiring::TopicAware { .. } => {
                let component_id = component_id.clone();
                let flow_runtime = Arc::clone(&state.flow_runtime);
                let app_handle = app.clone();
                Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                    log::info!("[Figma] Message on {} for component {}", msg.topic, component_id);
                    match flow_runtime.try_lock() {
                        Ok(mut runtime) => runtime.route_figma_message(&component_id, &msg.topic, &msg.payload),
                        Err(_) => log::debug!("[Figma] Runtime lock held, dropping message for {component_id}"),
                    }
                    let _ = app_handle.emit("mqtt-message", serde_json::json!({
                        "brokerId": "",
                        "topic": msg.topic,
                        "payload": String::from_utf8_lossy(&msg.payload).to_string(),
                        "componentId": component_id,
                    }));
                })
            }
            SubscriberWiring::DisplayEcho { .. } => {
                if !display_echo_seen.insert((broker_id.clone(), topic.clone())) {
                    // Already subscribed (different component requested same display topic).
                    continue;
                }
                let app_handle = app.clone();
                Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                    let _ = app_handle.emit("mqtt-message", serde_json::json!({
                        "brokerId": "",
                        "topic": msg.topic,
                        "payload": String::from_utf8_lossy(&msg.payload).to_string(),
                    }));
                })
            }
        };

        if let Err(e) = state.mqtt_manager.subscribe(&broker_id, &topic, callback).await {
            log::error!("[MQTT] Failed to subscribe component {component_id} to {topic}: {e}");
        }
        new_subs.push(crate::FigmaSubscription { broker_id, topic });
    }

    // Publish status=connected and request initial variable values, once per unique_id.
    for (uid, broker_id) in &new_unique_ids {
        if !state.mqtt_manager.is_connected(broker_id).await {
            continue;
        }
        let status_topic = format!("microflow/{uid}/app/status");
        if let Err(e) = state.mqtt_manager.publish(broker_id, &status_topic, b"connected", true).await {
            log::error!("[Figma] Failed to publish app/status: {e}");
        }
        let request_topic = format!("microflow/{uid}/app/variables/request");
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
