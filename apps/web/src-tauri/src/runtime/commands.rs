//! Tauri Commands for the Runtime
//!
//! `flow_update` and `component_call` commands

use super::host::ActorMsg;
use super::services::{HttpLlmProvider, LlmProvider};
use super::FlowUpdate;
use crate::codegen::board::{target_by_id, BoardTarget};
use crate::codegen::credentials::{Credentials, MissingCredential};
use crate::codegen::GenerationOutcome;
use crate::AppState;
use crate::mqtt::broker::BrokerConfig;
use microflow_core::runtime::{ComponentValue, SubscriberWiring};
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

    // Hand the flow to the runtime actor, which builds the components and (when a
    // board is connected) emits the pin-mode/reporting init. It replies with each
    // subscribe component's wiring so we can (un)subscribe MQTT below. The actor
    // re-applies this flow on every (re)connect and owns the "pending flow"
    // state, so there is no board-connected branch here.
    let component_wirings: Vec<(String, SubscriberWiring)> = {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        state
            .actor
            .send(ActorMsg::FlowUpdate { flow, reply: reply_tx })
            .map_err(|_| "runtime actor is gone".to_string())?;
        reply_rx
            .await
            .map_err(|_| "runtime actor dropped the flow_update reply".to_string())?
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
                let actor = state.actor.clone();
                let app_handle = app.clone();
                Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                    log::info!("[MQTT] Received message on topic {} for component {}", msg.topic, component_id);
                    let _ = actor.send(ActorMsg::Deliver {
                        id: component_id.clone(),
                        topic: msg.topic.clone(),
                        payload: msg.payload.clone(),
                    });
                    let _ = app_handle.emit(
                        "mqtt-message",
                        &crate::mqtt::commands::MqttMessage {
                            broker_id: String::new(),
                            topic: msg.topic,
                            payload: String::from_utf8_lossy(&msg.payload).to_string(),
                            component_id: Some(component_id.clone()),
                        },
                    );
                })
            }
            SubscriberWiring::TopicAware { .. } => {
                let component_id = component_id.clone();
                let actor = state.actor.clone();
                let app_handle = app.clone();
                Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                    log::info!("[Figma] Message on {} for component {}", msg.topic, component_id);
                    let _ = actor.send(ActorMsg::Deliver {
                        id: component_id.clone(),
                        topic: msg.topic.clone(),
                        payload: msg.payload.clone(),
                    });
                    let _ = app_handle.emit(
                        "mqtt-message",
                        &crate::mqtt::commands::MqttMessage {
                            broker_id: String::new(),
                            topic: msg.topic,
                            payload: String::from_utf8_lossy(&msg.payload).to_string(),
                            component_id: Some(component_id.clone()),
                        },
                    );
                })
            }
            SubscriberWiring::DisplayEcho { .. } => {
                if !display_echo_seen.insert((broker_id.clone(), topic.clone())) {
                    // Already subscribed (different component requested same display topic).
                    continue;
                }
                let app_handle = app.clone();
                Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                    let _ = app_handle.emit(
                        "mqtt-message",
                        &crate::mqtt::commands::MqttMessage {
                            broker_id: String::new(),
                            topic: msg.topic,
                            payload: String::from_utf8_lossy(&msg.payload).to_string(),
                            component_id: None,
                        },
                    );
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

/// Generate the Arduino sketch for a Flow, targeting a selected board.
///
/// Resolves `target_id` (the Flow's selected board target, Task #29) to the
/// Task #28 [`BoardTarget`] model; an absent or unknown id falls back to the
/// default target (`uno`) so existing Flows still generate. Validation runs
/// first (Task #35): when the Flow cannot run on the selected target, the
/// returned [`GenerationOutcome`] carries the validation problems and **no**
/// Sketch — never unrunnable code. Otherwise it carries the `.ino` source whose
/// pin numbers and capability usage reflect the selected board.
///
/// Pure translation: no board I/O, no Firmata, no persistence. Logically emits
/// the domain event `SketchGenerated`.
///
/// # Errors
///
/// Returns `Err(String)` with a human-readable message if sketch generation
/// fails. The skeleton never fails today, but the contract is fallible so later
/// per-Node emitters can surface failures to the frontend unchanged. A Flow that
/// cannot run on the target is **not** an error — it returns
/// `Ok(GenerationOutcome::Problems(..))`.
#[tauri::command]
pub async fn generate_sketch(
    flow: FlowUpdate,
    target_id: Option<String>,
    credentials: Option<Credentials>,
) -> Result<GenerationOutcome, String> {
    // Resolve the selected target, defaulting to the Uno when none is given or
    // the id is unknown, so existing Flows still produce a Sketch.
    let target = target_id
        .as_deref()
        .and_then(target_by_id)
        .unwrap_or_else(default_board_target);

    // Never log secret values — the `Credentials` Debug impl masks secrets, so
    // only log whether credentials were supplied at all.
    log::info!(
        "=== GENERATE SKETCH COMMAND === {} nodes, {} edges, target '{}', credentials: {}",
        flow.nodes.len(),
        flow.edges.len(),
        target.id,
        if credentials.is_some() { "provided" } else { "none" }
    );

    crate::codegen::generate_with_credentials(&flow, &target, credentials.as_ref())
}

/// Report which required network credentials are missing for `flow` on the
/// selected board target, so the editor can warn the Author *before* generating
/// a Sketch that would silently fail to connect.
///
/// Mirrors [`generate_sketch`]'s target resolution. Returns an empty list when
/// no credential is required (no Cloud Nodes, or a non-networking target).
/// Logically supports the `CredentialsProvided` domain event by validating the
/// Author's input. Secret values are never logged.
#[tauri::command]
#[must_use]
pub fn check_credentials(
    flow: FlowUpdate,
    target_id: Option<String>,
    credentials: Option<Credentials>,
) -> Vec<MissingCredential> {
    let target = target_id
        .as_deref()
        .and_then(target_by_id)
        .unwrap_or_else(default_board_target);
    credentials.unwrap_or_default().missing_for(&flow, &target)
}

/// The default board target (`uno`) used when a Flow has no explicit selection.
/// Falls back to the first supported target if the `uno` id ever changes, so
/// generation always has a target to work with.
fn default_board_target() -> BoardTarget {
    target_by_id("uno").unwrap_or_else(|| {
        crate::codegen::board::supported_targets()
            .into_iter()
            .next()
            .expect("at least one board target is supported")
    })
}

/// List the supported board targets so the editor can present a picker. The
/// frontend reads the stable id + human-readable name from each target; the
/// full pin/capability facts ride along for callers that need them. Mirrors the
/// `supported_targets()` registry consulted by generation, keeping one source
/// of truth for the supported list.
#[tauri::command]
#[must_use]
pub fn list_board_targets() -> Vec<BoardTarget> {
    crate::codegen::board::supported_targets()
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

    state
        .actor
        .send(ActorMsg::Call { id: component_id, method, value })
        .map_err(|_| "runtime actor is gone".to_string())
}
