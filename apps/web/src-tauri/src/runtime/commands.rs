//! Tauri Commands for the Runtime
//!
//! `flow_update` and `component_call` commands

use super::cloud_performer::Reconciled;
use super::host::ActorMsg;
use super::supervisor::RuntimeStatus;
use crate::codegen::board::{target_by_id, BoardTarget};
use crate::codegen::credentials::{Credentials, MissingCredential};
use crate::codegen::GenerationOutcome;
use crate::AppState;
use crate::mqtt::broker::BrokerConfig;
use crate::mqtt::MqttManager;
use microflow_core::flow::FlowUpdate;
use microflow_core::runtime::ComponentValue;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;
use tokio::time::Instant;

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

/// How long a flow update waits for the brokers in it that are not connected
/// yet: 2 seconds, for all of them together — once for each time a broker is
/// down, not on every update (`FlowUpdates::grace_of`).
///
/// A broker that is there answers a connect in well under a second — a few
/// hundred milliseconds over TLS and WebSocket to a hosted broker — so within
/// this grace the flow's subscriptions are in place when the update resolves,
/// exactly as when the broker was connected all along. A broker that is not
/// there takes up to the connect timeout (30 s) to be given up on, and the
/// flow must not wait for that: boards and local nodes are waiting for the
/// same update. Two seconds is several times what a working broker needs and
/// still short enough for an edit to feel applied.
pub const BROKER_GRACE: Duration = Duration::from_secs(2);

/// Update the flow with new nodes and edges
///
/// Flow updates are applied in the order they arrive ([`FlowUpdates`]). The
/// answer says whether the runtime is on a flow **at least as new** as this
/// one:
///
/// - `Ok` — this flow was applied, or a newer flow update arrived while this
///   one was still waiting for its brokers and that one was applied in its
///   place. An update that was replaced is never applied, and is not an error:
///   the webview answers an error by sending the flow it has again, and it has
///   already sent the newer one.
/// - `Err` — this flow was refused, or the one that replaced it was: the
///   runtime is on neither.
///
/// An update that was replaced answers when the one that replaced it does, not
/// before: until then nobody knows which flow the runtime ends up on.
#[tauri::command]
pub async fn flow_update(
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

    // Providers are no longer pushed down here: since ADR-0021 the webview owns
    // the LLM transport for both hosts and resolves `providerId` from its own
    // store at request time, so there is nothing for this side to hold. The
    // parameter is still accepted so an older frontend does not fail to invoke.
    let _ = providers;

    state.flow_updates.update(flow, brokers.as_deref().unwrap_or_default(), BROKER_GRACE).await
}

/// How a flow update ended, and which one it was.
#[derive(Clone)]
struct Settled {
    /// The number of the update, in the order of arrival.
    number: u64,
    result: Result<(), String>,
}

/// The flow updates the webview sends, **applied in the order they arrive**.
///
/// [`FlowUpdates::update`] is what the `flow_update` command does: bring the
/// flow's brokers up, then apply the flow.
///
/// The brokers come first so that the update resolves with the flow's
/// subscriptions in place — but only for as long as the grace
/// ([`BROKER_GRACE`]). The flow is applied whatever the brokers did, and the
/// result is the flow's alone: a broker that was late, or failed, is not a
/// failed flow update. Its connect carries on in the background, the pool's
/// status shows how it fares, and when it comes up the `CloudPerformer` makes
/// the flow's subscriptions on it by itself. A broker that stays away is
/// waited for once, not by every update that follows (`grace_of`).
///
/// **Order.** Waiting for brokers takes one update longer than another, and
/// the webview does not send a flow twice: an older flow applied after a newer
/// one would stay. So updates are numbered as they arrive, and an update is
/// handed to the runtime actor only while it is the newest. One that is still
/// waiting for its brokers when a newer one arrives is replaced by it: it is
/// never applied, and answers as the one that replaced it does (see
/// `flow_update` for what the webview makes of that). The actor applies what
/// it is handed in the order of handing over.
pub struct FlowUpdates {
    actor: UnboundedSender<ActorMsg>,
    pool: MqttManager,
    /// The number of the newest update that arrived. Numbering an update
    /// writes it, handing one to the actor reads it and keeps it read until
    /// the flow is in the actor's queue: a newer update cannot be numbered
    /// between the check and the hand-over.
    arrived: watch::Sender<u64>,
    /// The newest update that was handed to the actor, and how it ended.
    settled: watch::Sender<Settled>,
    /// The grace each broker was last given, by broker id ([`Self::grace_of`]).
    graces: Mutex<HashMap<String, Grace>>,
}

/// Settles an update that is dropped before it ended, so that the ones it
/// replaced do not wait for it for ever.
struct Unsettled<'a> {
    settled: &'a watch::Sender<Settled>,
    number: u64,
    /// The update ended, or was replaced: there is nothing to settle.
    done: bool,
}

impl Unsettled<'_> {
    fn settle(&mut self, result: &Result<(), String>) {
        self.done = true;
        let settled = Settled { number: self.number, result: result.clone() };
        // Updates end in any order; the newest that ended is what counts.
        self.settled.send_if_modified(|newest| {
            let newer = settled.number > newest.number;
            if newer {
                *newest = settled;
            }
            newer
        });
    }
}

impl Drop for Unsettled<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.settle(&Err("the flow update was abandoned".to_string()));
        }
    }
}

impl FlowUpdates {
    /// Flow updates for the runtime behind `actor`, whose brokers are in
    /// `pool`.
    #[must_use]
    pub fn new(actor: UnboundedSender<ActorMsg>, pool: MqttManager) -> Self {
        Self {
            actor,
            pool,
            arrived: watch::channel(0).0,
            settled: watch::channel(Settled { number: 0, result: Ok(()) }).0,
            graces: Mutex::new(HashMap::new()),
        }
    }

    /// Apply `flow`, having given the brokers in `brokers` that are not
    /// connected `grace` to come up. See [`FlowUpdates`] for the order of
    /// updates and `flow_update` for what the answer means.
    pub async fn update(&self, flow: FlowUpdate, brokers: &[FrontendBrokerConfig], grace: Duration) -> Result<(), String> {
        let mut number = 0;
        self.arrived.send_modify(|arrived| {
            *arrived += 1;
            number = *arrived;
        });
        let mut unsettled = Unsettled { settled: &self.settled, number, done: false };

        // Bring the brokers up — until a newer update arrives.
        let mut arrived = self.arrived.subscribe();
        let replaced = tokio::select! {
            biased;
            _ = arrived.wait_for(|newest| *newest > number) => true,
            () = self.bring_up_brokers(brokers, grace) => false,
        };
        let handed_over = if replaced { None } else { self.hand_over(number, flow) };
        let Some(handed_over) = handed_over else {
            unsettled.done = true;
            log::info!("[FLOW] Flow update {number} was replaced by a newer one before it was applied");
            return self.result_of_newer(number).await;
        };

        let result = match handed_over {
            Ok(applying) => applied(applying).await,
            Err(gone) => Err(gone),
        };
        unsettled.settle(&result);
        result
    }

    /// Put `flow` in the actor's queue if update `number` is still the newest
    /// that arrived; `None` if it is not. `Some(Err)` when the actor is gone.
    fn hand_over(&self, number: u64, flow: FlowUpdate) -> Option<Result<Applying, String>> {
        let newest = self.arrived.borrow();
        (*newest == number).then(|| send_flow(&self.actor, flow))
    }

    /// How the newest update that ended after update `number` was replaced
    /// ended.
    async fn result_of_newer(&self, number: u64) -> Result<(), String> {
        let mut settled = self.settled.subscribe();
        let result = match settled.wait_for(|settled| settled.number > number).await {
            Ok(settled) => settled.result.clone(),
            Err(_) => Err("the flow updates are gone".to_string()),
        };
        result
    }

    /// Connect the brokers that are not connected as `brokers` says, all at
    /// once, and wait for the ones that still have a grace
    /// ([`Self::grace_of`]) — together, until the last of their graces ends.
    /// Whatever is still connecting then keeps connecting, as it does when
    /// this future is dropped.
    async fn bring_up_brokers(&self, brokers: &[FrontendBrokerConfig], grace: Duration) {
        // The connects run on tasks of their own: they are to carry on when
        // nobody waits for them any more.
        let (answers, mut answered) = tokio::sync::mpsc::unbounded_channel();
        // The brokers waited for, and when the grace of each ends.
        let mut awaited: HashMap<String, Instant> = HashMap::new();
        for broker in brokers {
            let config = BrokerConfig {
                id: broker.id.clone(),
                url: broker.url.clone(),
                username: broker.username.clone(),
                password: broker.password.clone(),
            };

            // Already up with the same config — nothing to do. (Otherwise
            // every node edit logged a misleading "Auto-connecting /
            // Successfully connected" pair around a connect that had nothing
            // to connect.)
            let connected = self.pool.is_connected(&broker.id).await;
            if connected && !self.pool.config_changed(&broker.id, &config).await {
                continue;
            }

            // A broker that is up on other settings has its session ended by
            // the pool before the new ones are tried, and with it the flow's
            // subscriptions; the `CloudPerformer` sees the new session and
            // re-subscribes the flow's topics on it.
            log::info!("[MQTT] Auto-connecting broker: {} ({})", broker.name, broker.id);
            let connecting = self.pool.connect(config);
            if let Some(until) = self.grace_of(&broker.id, grace) {
                awaited.insert(broker.id.clone(), until);
            }
            let (answers, id, name) = (answers.clone(), broker.id.clone(), broker.name.clone());
            tokio::spawn(async move {
                let connected = connecting.await;
                match &connected {
                    Ok(()) => log::info!("[MQTT] Successfully connected to broker: {name}"),
                    Err(e) => log::error!("[MQTT] Failed to auto-connect broker {name}: {e}"),
                }
                let _ = answers.send((id, connected.is_ok()));
            });
        }
        drop(answers);

        while let Some(until) = awaited.values().max().copied() {
            tokio::select! {
                answer = answered.recv() => {
                    let Some((id, connected)) = answer else { break };
                    // A broker that answered that it is not coming up has had
                    // its grace.
                    if awaited.remove(&id).is_some() && !connected {
                        self.end_grace(&id);
                    }
                }
                () = tokio::time::sleep_until(until) => break,
            }
        }
        if !awaited.is_empty() {
            log::warn!(
                "[MQTT] {} broker(s) not connected within their grace: the flow is applied without them, \
                 and subscribed on each when it connects",
                awaited.len()
            );
        }
    }

    /// Until when a flow update waits for `broker_id`, which is not connected
    /// and has just been asked to connect; `None` when it is not waited for.
    ///
    /// **A broker gets one grace for each time it is down.** The first update
    /// that finds it down gives it `grace`; the updates that arrive within it
    /// wait for what is left of it, and the ones after it do not wait at all.
    /// The grace is for a broker that is about to come up, and one that did
    /// not has shown that it is not: waiting for it again, on every edit for
    /// as long as it stays away, would only make every edit late. It gets a
    /// grace again once it has come up, or has been given other settings —
    /// which is what the pool's [stretch](MqttManager::stretch) tells apart.
    fn grace_of(&self, broker_id: &str, grace: Duration) -> Option<Instant> {
        let stretch = self.pool.stretch(broker_id)?;
        let now = Instant::now();
        let mut graces = self.graces.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(given) = graces.get(broker_id).filter(|given| given.stretch == stretch) {
            return (given.until > now).then_some(given.until);
        }
        let until = now + grace;
        graces.insert(broker_id.to_string(), Grace { stretch, until });
        Some(until)
    }

    /// `broker_id` will not come up on the attempt that was waited for: its
    /// grace is over.
    fn end_grace(&self, broker_id: &str) {
        let mut graces = self.graces.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(given) = graces.get_mut(broker_id) {
            given.until = Instant::now();
        }
    }
}

/// The grace a broker was given to come up in.
struct Grace {
    /// The [stretch](MqttManager::stretch) of being down it was given for.
    stretch: u64,
    until: Instant,
}

/// Re-enter one LLM result value on the issuing node's handle.
///
/// The webview half of the ADR-0021 split: `Actor::perform_cloud` forwards an
/// `llmGenerate` request as an `llm-request` event, the frontend performs it
/// with `TanStack` AI (`ai/llm-client.ts`), and every emission it
/// produces — the streaming `value` deltas, then `thinking`/`done` or `error` —
/// comes back through here onto `ActorMsg::Inject`, the same path an MQTT
/// delivery or a hotkey takes.
///
/// A result for a node that is gone is harmless: its edges went with it, so
/// `inject_event` routes nowhere.
#[tauri::command]
pub async fn llm_result(
    source: String,
    handle: String,
    value: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let value = match value {
        serde_json::Value::Bool(b) => ComponentValue::Bool(b),
        serde_json::Value::Number(n) => ComponentValue::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => ComponentValue::String(s),
        _ => ComponentValue::default(),
    };

    state
        .actor
        .send(ActorMsg::Inject { source: Arc::from(source.as_str()), handle, value })
        .map_err(|_| "runtime actor is gone".to_string())
}

/// Leave a crash-loop halt: the actor forgets its recorded panics and respawns
/// the runtime with the live board's pins and the last flow. The webview's
/// "runtime halted" error offers this (then reloads, so the flow and its MQTT
/// subscriptions are re-sent from the document).
#[tauri::command]
pub async fn runtime_restart(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.actor.send(ActorMsg::Restart).map_err(|_| "runtime actor is gone".to_string())
}

/// Whether the runtime is halted by the crash-loop guard, and the crash that
/// halted it. The webview asks on start, so a reload (or a dismissed error)
/// cannot leave a halted runtime with nothing on screen.
#[tauri::command]
pub async fn runtime_status(state: tauri::State<'_, AppState>) -> Result<RuntimeStatus, String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    state.actor.send(ActorMsg::Status { reply }).map_err(|_| "runtime actor is gone".to_string())?;
    rx.await.map_err(|_| "runtime actor dropped the status reply".to_string())
}

/// The actor's half of a flow update — queue the flow, wait until it is
/// applied — without the brokers and the ordering before it: for the actor's
/// own tests.
#[cfg(test)]
pub(crate) async fn apply_flow(actor: &UnboundedSender<ActorMsg>, flow: FlowUpdate) -> Result<(), String> {
    applied(send_flow(actor, flow)?).await
}

/// A flow in the actor's queue: the actor's reply to it.
type Applying = tokio::sync::oneshot::Receiver<Result<Reconciled, String>>;

/// Put `flow` in the queue of the runtime behind `actor`. The actor applies
/// flows in the order they were queued.
///
/// The runtime actor builds the components and (when a board is connected)
/// emits the pin-mode/reporting init; it re-applies this flow on every
/// (re)connect and owns the "pending flow" state, so there is no
/// board-connected branch here.
fn send_flow(actor: &UnboundedSender<ActorMsg>, flow: FlowUpdate) -> Result<Applying, String> {
    let (reply, applying) = tokio::sync::oneshot::channel();
    actor.send(ActorMsg::FlowUpdate { flow, reply }).map_err(|_| "runtime actor is gone".to_string())?;
    Ok(applying)
}

/// Wait until the actor has applied the flow and its MQTT subscriptions are
/// in place. The actor hands the runtime's subscriber wirings to the
/// `CloudPerformer`, which owns the subscriptions, and its reply carries that
/// reconcile: waiting on it is all that is left to do here, so the command
/// returns with the flow's topics subscribed and its design-tool plugins
/// announced to.
async fn applied(applying: Applying) -> Result<(), String> {
    let reconciled = applying.await.map_err(|_| "runtime actor dropped the flow_update reply".to_string())??;
    reconciled.applied().await;
    Ok(())
}

/// Generate the Arduino sketch for a Flow, targeting a selected board.
///
/// Resolves `target_id` (the Flow's selected board target) to the
/// [`BoardTarget`] model; an absent or unknown id falls back to the default
/// target (`uno`) so existing Flows still generate. Validation runs first: the
/// returned [`GenerationOutcome`] carries the `.ino` source plus any validation
/// problems. Board-fit conflicts are warnings and never block the Sketch; only
/// error-severity problems (uncompilable C++, e.g. colliding Node identifiers)
/// suppress it.
///
/// Pure translation: no board I/O, no Firmata, no persistence. Logically emits
/// the domain event `SketchGenerated`.
///
/// # Errors
///
/// Returns `Err(String)` with a human-readable message if sketch generation
/// fails. The skeleton never fails today, but the contract is fallible so later
/// per-Node emitters can surface failures to the frontend unchanged. A Flow that
/// conflicts with the target is **not** an error — the problems ride in the
/// returned outcome.
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

/// Report which required network credentials are missing for `flow`, so the
/// editor can warn the Author *before* generating a Sketch that would silently
/// fail to connect.
///
/// Returns an empty list when no credential is required (no Cloud Nodes). The
/// check is independent of the board target — a Cloud Flow on a non-networking
/// target still emits its network code (with a validation warning), so its
/// credential needs are the same; `target_id` is kept so the IPC boundary is
/// unchanged. Logically supports the `CredentialsProvided` domain event by
/// validating the Author's input. Secret values are never logged.
#[tauri::command]
#[must_use]
pub fn check_credentials(
    flow: FlowUpdate,
    #[allow(unused_variables)] target_id: Option<String>,
    credentials: Option<Credentials>,
) -> Vec<MissingCredential> {
    credentials.unwrap_or_default().missing_for(&flow)
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
