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
use microflow_core::runtime::{
    figma_announce_actions, reconcile_desired, ComponentValue, DesiredSub, SubscriberWiring,
};
use std::collections::{BTreeMap, HashMap};
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

/// Map the live/desired subscription set to `uid -> broker_id` over its
/// `microflow/{uid}` topics. Generic over the map value so it serves both the
/// `FigmaSubscription` (live) and core [`DesiredSub`] (desired) maps. The uid
/// *extraction* stays host-side (trivial parsing of this host's own subscription
/// set, like the desired→live set-diff); the connect/disconnect *protocol* it
/// feeds lives in core ([`figma_announce_actions`]). `BTreeMap` so the keys land
/// in the deterministic order core expects.
fn uid_brokers<V>(set: &HashMap<(String, String), V>) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for (broker_id, topic) in set.keys() {
        if let Some(uid) = microflow_uid(topic) {
            out.entry(uid.to_string()).or_insert_with(|| broker_id.clone());
        }
    }
    out
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

    // Ordering — keep the runtime reflecting the latest flow; report infra
    // separately. `apply_flow`'s subscription reconcile diffs the desired set
    // against *live* brokers (its `is_connected` checks decide what to
    // (un)subscribe and which subs to commit), so infrastructure has to be up
    // *before* it runs; we therefore cannot defer `ensure_infrastructure` until
    // after `apply_flow` without changing reconcile semantics. To still guarantee
    // that an infrastructure error never strands the flow, we capture its result
    // instead of `?`-propagating it, ALWAYS apply the flow, and only then surface
    // the infrastructure outcome as the command result. Both steps are idempotent,
    // so a reported infra failure is safe to retry.
    let infrastructure = ensure_infrastructure(&brokers, providers, &state).await;
    apply_flow(&app, flow, &state).await?;
    infrastructure
}

/// Bring the flow's external infrastructure up to date: auto-connect/refresh the
/// provided MQTT brokers and sync LLM provider credentials into the shared
/// registry. Orthogonal to the flow itself — idempotent and safe to retry. Split
/// out of [`flow_update`] so an infrastructure failure can be surfaced to the
/// caller without ever unwinding the applied flow (see the ordering note in
/// `flow_update`). Fallible by contract; today a per-broker connect failure is
/// logged and tolerated (the loop continues), matching the previous inline
/// behaviour.
async fn ensure_infrastructure(
    brokers: &Option<Vec<FrontendBrokerConfig>>,
    providers: Option<Vec<FrontendProviderConfig>>,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Auto-connect any brokers that are provided. Skip brokers already up with
    // unchanged config: otherwise every node edit logged a misleading
    // "Auto-connecting / Successfully connected" pair around an idempotent
    // connect() that just short-circuited on "already connected".
    if let Some(broker_configs) = brokers {
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

    Ok(())
}

/// Apply `flow` to the runtime and reconcile its MQTT/Figma subscriptions. Hands
/// the flow to the runtime actor (which owns the "pending flow" and re-applies it
/// on every (re)connect), then diffs the desired subscriber set against the live
/// one and (un)subscribes only the delta, finishing with the Figma connect/
/// disconnect status + variable-request publishes driven by that reconciled set.
/// This is the deep half of [`flow_update`]; the reconcile semantics are
/// unchanged by the split.
async fn apply_flow(
    app: &tauri::AppHandle,
    flow: FlowUpdate,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
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

    // Desired subscription set, one entry per (broker_id, topic). The collapse +
    // deterministic winner-selection is core policy (`reconcile_desired`), shared
    // with the browser host so both pick the same owner per topic; here we key it
    // by (broker, topic) for the diff against the live set below.
    let desired: HashMap<(String, String), DesiredSub> = reconcile_desired(&component_wirings)
        .into_iter()
        .map(|d| ((d.broker_id.clone(), d.topic.clone()), d))
        .collect();

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
            if existing.component_id == d.node_id && existing.kind == d.kind {
                next_live.push(existing.clone());
                continue;
            }
        }

        if !state.mqtt_manager.is_connected(broker_id).await {
            log::warn!(
                "[MQTT] Broker {broker_id} not connected, skipping subscription for {}",
                d.node_id
            );
            continue;
        }

        let component_id = d.node_id.clone();
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

    // Figma plugin handshake: a vanished uid announces `disconnected`, a newly
    // appeared one announces `connected` + requests its current variables. That
    // protocol — topics, payloads, retain — lives in core
    // ([`figma_announce_actions`]), shared with the browser host so both announce
    // identically; here we only perform the publishes, gated on a live broker like
    // every publish above. Runs *after* the (un)subscribe diff so a new uid's
    // variable request can't outrun the subscription that catches the reply — the
    // browser host orders its `figmaLifecycle` the same way.
    for action in figma_announce_actions(&old_uids, &new_uids) {
        if !state.mqtt_manager.is_connected(&action.broker_id).await {
            continue;
        }
        if let Err(e) = state
            .mqtt_manager
            .publish(&action.broker_id, &action.topic, action.payload.as_bytes(), action.retain)
            .await
        {
            log::error!("[Figma] publish to {} failed: {e}", action.topic);
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
