//! MQTT Tauri Commands
//!
//! Exposes MQTT functionality to the frontend via Tauri commands.

use super::broker::{BrokerConfig, ConnectionStatus, MqttMessage as BrokerMessage, Subscriber};
use super::manager::StatusSnapshot;
use super::MqttManager;
use crate::runtime::host::HostEvents;
use crate::AppState;
use std::sync::Arc;
use tauri::State;
use ts_rs::TS;

/// Payload of the `mqtt-message` Tauri event. Frontend deserializes this with
/// `snake_case` field names; do not hand-roll JSON for this event elsewhere.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct MqttMessage {
    pub broker_id: String,
    pub topic: String,
    pub payload: String,
    /// Set when the message reached a subscribed component (Plain/TopicAware
    /// flows in `runtime::cloud_performer`); `null` for direct broker subscriptions.
    /// Always serialized so the ts-rs binding mirrors the struct verbatim.
    pub component_id: Option<String>,
}

/// Broker status info returned to frontend
#[derive(Debug, Clone, serde::Serialize, TS)]
#[ts(export)]
pub struct BrokerStatus {
    pub id: String,
    pub status: ConnectionStatus,
}

/// Every broker's status at one moment, numbered: what `mqtt_sync_brokers`
/// answers and the [`BROKER_STATUS_EVENT`] carries. The two can arrive in
/// either order; the one with the higher `seq` shows the later state, and the
/// frontend keeps that one ([`MqttManager::status_snapshot`]).
#[derive(Debug, Clone, serde::Serialize, TS)]
#[ts(export)]
pub struct BrokerStatuses {
    #[ts(type = "number")]
    pub seq: u64,
    pub brokers: Vec<BrokerStatus>,
}

impl From<&StatusSnapshot> for BrokerStatuses {
    fn from(snapshot: &StatusSnapshot) -> Self {
        Self { seq: snapshot.seq, brokers: broker_statuses(&snapshot.statuses) }
    }
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

/// Subscribe the Connection Console to a topic. It subscribes as
/// [`Subscriber::Console`], beside whatever the running flow holds on the same
/// topic: neither replaces the other's deliveries.
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
            component_id: None,
        };
        HostEvents::emit(&app_handle, "mqtt-message", message);
    });

    state
        .mqtt_manager
        .subscribe(&broker_id, &topic, Subscriber::Console, callback)
        .await
        .map(|_session| ())
}

/// Unsubscribe the Connection Console from a topic. A flow node subscribed to
/// the same topic keeps receiving.
///
/// The console's subscription ends with this call whatever the broker is
/// doing — connected, its link down, or not in the pool: the console calls it
/// when a page is left and does not look at the answer. The error is for a
/// topic the console did not hold on a broker that is not connected.
#[tauri::command]
pub async fn mqtt_unsubscribe(
    state: State<'_, AppState>,
    broker_id: String,
    topic: String,
) -> Result<(), String> {
    state.mqtt_manager.unsubscribe(&broker_id, &topic, Subscriber::Console).await
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

/// The broker settings, all of them: called on app startup and whenever a
/// broker's settings change, which while the user types is on every keystroke,
/// with calls overlapping. The pool takes it from there
/// ([`MqttManager::sync`](super::MqttManager::sync)): the last list given is
/// the truth, every broker in it is connected as it says, and the ones no
/// longer in it leave the pool with the console's subscriptions for their id.
///
/// Resolves once the pool has been told, with every broker's status as it is
/// then — `connecting` for the ones being dialled. No broker is waited for:
/// how each of them fares follows on the [`BROKER_STATUS_EVENT`], which may
/// arrive before this answer does.
#[tauri::command]
pub async fn mqtt_sync_brokers(
    state: State<'_, AppState>,
    brokers: Vec<SyncBrokerConfig>,
) -> Result<BrokerStatuses, String> {
    log::info!("[MQTT] Syncing {} broker configs", brokers.len());

    let configs = brokers
        .into_iter()
        .map(|broker| BrokerConfig {
            id: broker.id,
            url: broker.url,
            username: broker.username,
            password: broker.password,
        })
        .collect();
    state.mqtt_manager.sync(configs).await;

    Ok(BrokerStatuses::from(&state.mqtt_manager.status_snapshot().await))
}

/// Get status of all known brokers
#[tauri::command]
pub async fn mqtt_all_statuses(state: State<'_, AppState>) -> Result<Vec<BrokerStatus>, String> {
    Ok(broker_statuses(&state.mqtt_manager.status_snapshot().await.statuses))
}

/// The pool's statuses, as the frontend takes them.
fn broker_statuses(statuses: &[(String, ConnectionStatus)]) -> Vec<BrokerStatus> {
    statuses.iter().map(|(id, status)| BrokerStatus { id: id.clone(), status: *status }).collect()
}

/// The webview event that carries the status of every broker the pool knows,
/// as [`BrokerStatuses`]. The frontend replaces what it shows with the list —
/// a broker that is not in it has no status — unless it holds a newer one.
pub const BROKER_STATUS_EVENT: &str = "mqtt-broker-status";

/// Emit the [`BROKER_STATUS_EVENT`] on `events` whenever the status of a
/// broker in `pool` changes, whatever changed it: a `connect` starting,
/// getting through or failing, a link that dropped, a client that repaired
/// it, a broker that was disconnected or removed. Nothing is emitted while
/// nothing changes. Runs for as long as it is polled; the app spawns it once.
pub async fn report_broker_statuses<E: HostEvents>(pool: MqttManager, events: E) {
    pool.report_statuses(|snapshot| events.emit(BROKER_STATUS_EVENT, BrokerStatuses::from(snapshot))).await;
}
