//! Tauri Commands for the Runtime
//!
//! `flow_update` and `component_call` commands

use super::host::ActorMsg;
use super::services::{HttpLlmProvider, LlmProvider};
use crate::codegen::board::{target_by_id, BoardTarget};
use crate::codegen::credentials::{Credentials, MissingCredential};
use crate::codegen::GenerationOutcome;
use crate::AppState;
use crate::mqtt::broker::BrokerConfig;
use microflow_core::flow::FlowUpdate;
use crate::SubKind;
use microflow_core::runtime::{ComponentValue, SubscriberWiring};
use std::collections::HashMap;
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

/// The `SubKind` a wiring resolves to (records which callback shape owns the
/// broker's single per-topic callback).
fn sub_kind(wiring: &SubscriberWiring) -> SubKind {
    match wiring {
        SubscriberWiring::Plain { .. } => SubKind::Plain,
        SubscriberWiring::TopicAware { .. } => SubKind::TopicAware,
        SubscriberWiring::DisplayEcho { .. } => SubKind::DisplayEcho,
    }
}

/// Map the live/desired subscription set to `uid -> broker_id` over its
/// `microflow/{uid}` topics. Generic over the map value so it serves both the
/// `FigmaSubscription` (live) and `DesiredSub` (desired) maps.
fn uid_brokers<V>(set: &HashMap<(String, String), V>) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for (broker_id, topic) in set.keys() {
        if let Some(uid) = microflow_uid(topic) {
            out.entry(uid.to_string()).or_insert_with(|| broker_id.clone());
        }
    }
    out
}

/// One desired subscription, before it is reconciled against the live set.
#[derive(Clone)]
struct DesiredSub {
    component_id: String,
    kind: SubKind,
}

impl DesiredSub {
    /// Deterministic winner when several components resolve to the same
    /// `(broker, topic)` — the broker keeps a single callback per topic.
    /// Routing kinds (`Plain`/`TopicAware`) win over `DisplayEcho` so a
    /// display-only echo never shadows component delivery; ties break on the
    /// lower component id. Being deterministic (not dependent on component
    /// `HashMap` iteration order) is what keeps the desired set stable across
    /// `flow_update`s, so an unchanged flow reconciles to *zero* broker traffic.
    fn beats(&self, other: &DesiredSub) -> bool {
        let echo = |k: SubKind| matches!(k, SubKind::DisplayEcho);
        match (echo(self.kind), echo(other.kind)) {
            (false, true) => true,
            (true, false) => false,
            _ => self.component_id < other.component_id,
        }
    }
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

    // Auto-connect any brokers that are provided. Skip brokers already up with
    // unchanged config: otherwise every node edit logged a misleading
    // "Auto-connecting / Successfully connected" pair around an idempotent
    // connect() that just short-circuited on "already connected".
    if let Some(broker_configs) = &brokers {
        for broker in broker_configs {
            let config = BrokerConfig {
                id: broker.id.clone(),
                url: broker.url.clone(),
                username: broker.username.clone(),
                password: broker.password.clone(),
            };

            let connected = state.mqtt_manager.is_connected(&broker.id).await;
            let config_changed = state.mqtt_manager.config_changed(&broker.id, &config).await;

            // Already up with the same config — nothing to do.
            if connected && !config_changed {
                continue;
            }

            // Config changed while connected: connect() short-circuits on
            // "already connected" and would never apply the new url/creds, so
            // tear the connection down first. disconnect() also drops the
            // broker-side subscriptions, so forget this broker's tracked subs —
            // the reconciliation below then re-subscribes them on the fresh
            // connection instead of treating them as still-live and skipping.
            if connected && config_changed {
                log::info!("[MQTT] Broker {} config changed; reconnecting", broker.name);
                let _ = state.mqtt_manager.disconnect(&broker.id).await;
                let mut subs = state.figma_subscriptions.lock().await;
                subs.retain(|s| s.broker_id != broker.id);
            }

            log::info!("[MQTT] Auto-connecting broker: {} ({})", broker.name, broker.id);
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

    // Desired subscription set, one entry per (broker_id, topic). The broker
    // keeps a single callback per topic, so when several components resolve to
    // the same topic we pick a deterministic winner (see DesiredSub::beats),
    // which also subsumes the old DisplayEcho dedup.
    let mut desired: HashMap<(String, String), DesiredSub> = HashMap::new();
    for (component_id, wiring) in &component_wirings {
        let key = (wiring.broker_id().to_string(), wiring.topic().to_string());
        let cand = DesiredSub { component_id: component_id.clone(), kind: sub_kind(wiring) };
        desired
            .entry(key)
            .and_modify(|cur| {
                if cand.beats(cur) {
                    *cur = cand.clone();
                }
            })
            .or_insert(cand);
    }

    // Snapshot the live subscriptions, then release the lock for the network I/O
    // below (re-locked at the end to commit) — matching the original's
    // lock-only-around-state discipline.
    let live: HashMap<(String, String), crate::FigmaSubscription> = {
        let subs = state.figma_subscriptions.lock().await;
        subs.iter()
            .map(|s| ((s.broker_id.clone(), s.topic.clone()), s.clone()))
            .collect()
    };

    // Diff desired against live and touch only the delta. Moving a node leaves
    // the wiring identical, so every (un)subscribe below is skipped; adding or
    // removing a node (un)subscribes just its own topic(s).
    let old_uids = uid_brokers(&live);
    let new_uids = uid_brokers(&desired);

    // Vanished Figma uids: publish a retained `disconnected` status.
    for (uid, broker_id) in &old_uids {
        if !new_uids.contains_key(uid) {
            let status_topic = format!("microflow/{uid}/app/status");
            let _ = state.mqtt_manager.publish(broker_id, &status_topic, b"disconnected", true).await;
            log::info!("[Figma] Published disconnected status for {uid}");
        }
    }

    // Removed topics (in live, gone from desired): unsubscribe.
    for (key, sub) in &live {
        if desired.contains_key(key) {
            continue;
        }
        log::info!("[Figma] Unsubscribing old topic: {} on broker {}", sub.topic, sub.broker_id);
        if let Err(e) = state.mqtt_manager.unsubscribe(&sub.broker_id, &sub.topic).await {
            log::warn!("[Figma] Failed to unsubscribe {}: {}", sub.topic, e);
        }
    }

    // New or owner/kind-changed topics: (re)subscribe. Unchanged topics keep
    // their existing broker callback untouched. The committed set carries over
    // unchanged entries plus the ones we (re)subscribed; a topic whose broker is
    // offline is intentionally *not* committed, so a later connected
    // `flow_update` retries it.
    let mut next_live: Vec<crate::FigmaSubscription> = Vec::with_capacity(desired.len());
    for ((broker_id, topic), d) in &desired {
        if let Some(existing) = live.get(&(broker_id.clone(), topic.clone())) {
            if existing.component_id == d.component_id && existing.kind == d.kind {
                next_live.push(existing.clone());
                continue;
            }
        }

        if !state.mqtt_manager.is_connected(broker_id).await {
            log::warn!(
                "[MQTT] Broker {broker_id} not connected, skipping subscription for {}",
                d.component_id
            );
            continue;
        }

        let component_id = d.component_id.clone();
        let callback: Arc<dyn Fn(crate::mqtt::broker::MqttMessage) + Send + Sync> = match d.kind {
            SubKind::Plain | SubKind::TopicAware => {
                let actor = state.actor.clone();
                let app_handle = app.clone();
                let cid = component_id.clone();
                Arc::new(move |msg: crate::mqtt::broker::MqttMessage| {
                    log::info!("[MQTT] Received message on topic {} for component {}", msg.topic, cid);
                    let _ = actor.send(ActorMsg::Deliver {
                        id: cid.clone(),
                        topic: msg.topic.clone(),
                        payload: msg.payload.clone(),
                    });
                    let _ = app_handle.emit(
                        "mqtt-message",
                        &crate::mqtt::commands::MqttMessage {
                            broker_id: String::new(),
                            topic: msg.topic,
                            payload: String::from_utf8_lossy(&msg.payload).to_string(),
                            component_id: Some(cid.clone()),
                        },
                    );
                })
            }
            SubKind::DisplayEcho => {
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

        if let Err(e) = state.mqtt_manager.subscribe(broker_id, topic, callback).await {
            log::error!("[MQTT] Failed to subscribe component {component_id} to {topic}: {e}");
        }
        next_live.push(crate::FigmaSubscription {
            broker_id: broker_id.clone(),
            topic: topic.clone(),
            component_id,
            kind: d.kind,
        });
    }

    // Newly-appeared Figma uids only: announce connected + request initial
    // variable values (retained), once per uid — not on every node move.
    for (uid, broker_id) in &new_uids {
        if old_uids.contains_key(uid) || !state.mqtt_manager.is_connected(broker_id).await {
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

    // Commit the reconciled live set for the next flow_update to diff against.
    {
        let mut subs = state.figma_subscriptions.lock().await;
        *subs = next_live;
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
