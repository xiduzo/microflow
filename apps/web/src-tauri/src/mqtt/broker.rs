//! MQTT Broker Client
//!
//! Simple MQTT client implementation using mqtt-endpoint-tokio.

use mqtt_endpoint_tokio::mqtt_ep;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};

/// Configuration for MQTT reconnection with exponential backoff
#[derive(Debug, Clone)]
pub struct ReconnectConfig {
    /// Initial delay before first reconnection attempt (default: 1s)
    pub initial_delay: Duration,
    /// Maximum delay between attempts (default: 60s)
    pub max_delay: Duration,
    /// Multiplier applied to delay after each failure (default: 2.0)
    pub multiplier: f64,
    /// Maximum number of attempts, None for infinite (default: None)
    pub max_attempts: Option<usize>,
    /// How long one connection attempt — the first, or a reconnect — may take
    /// from opening the transport to the broker's CONNACK (default:
    /// [`CONNECT_TIMEOUT`]). An attempt that is not through by then has
    /// failed: the status becomes `Error` and the next attempt follows the
    /// backoff above.
    pub connect_timeout: Duration,
    /// How long one write to a link that is up — a SUBSCRIBE, an UNSUBSCRIBE,
    /// a PUBLISH, the DISCONNECT — may take (default: [`WRITE_TIMEOUT`]). A
    /// write that is not through by then has failed, and its link is treated
    /// as dropped: the client is `Disconnected` and repairs it by the backoff
    /// above.
    pub write_timeout: Duration,
}

/// The default bound on one write to a link: 10 seconds.
///
/// A write is a few bytes into the socket's buffer, done in microseconds on a
/// link that works. It takes longer only when that buffer is full because the
/// other side has stopped reading: a link that stalled without dropping,
/// which TCP itself gives up on after minutes. Whoever writes holds the client
/// for the length of the write, and everything that asks about the broker
/// meanwhile — its session, its status, a reconcile, a `flow_update` — waits
/// behind it. Ten seconds is far beyond what a write on a working link takes,
/// also a large payload on a slow uplink, and short enough for a stalled link
/// to be found out and repaired while the user is still looking.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// The default bound on one connection attempt: 30 seconds.
///
/// An attempt is at most a TCP handshake, a TLS handshake, a WebSocket upgrade
/// and the CONNECT/CONNACK exchange — some seven round trips. Over a bad
/// mobile or satellite link (a second or two per round trip) that is ten to
/// fifteen seconds, so 30 leaves a slow broker twice what it needs, while a
/// host that swallows packets is given up on long before the operating
/// system's own TCP timeout (over a minute) and instead of never, which is
/// what a broker that accepts the connection and then says nothing got before.
/// It is also `mqtt.js`'s default `connectTimeout`, which the browser host
/// runs on: both hosts give up on a silent broker at the same moment.
///
/// Nothing but the attempt itself waits this long: no lock is held across it
/// (see `Dialer`).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            multiplier: 2.0,
            max_attempts: None,
            connect_timeout: CONNECT_TIMEOUT,
            write_timeout: WRITE_TIMEOUT,
        }
    }
}

impl ReconnectConfig {
    /// Calculate the next delay after a failed attempt
    #[must_use] 
    pub fn next_delay(&self, current: Duration) -> Duration {
        let next_secs = current.as_secs_f64() * self.multiplier;
        let capped_secs = next_secs.min(self.max_delay.as_secs_f64());
        Duration::from_secs_f64(capped_secs)
    }
}

/// Type alias for client endpoint
type ClientEndpoint = mqtt_ep::endpoint::Endpoint<mqtt_ep::role::Client>;

/// Connection status for a broker
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

/// Parsed URL components
#[derive(Debug, Clone)]
struct ParsedUrl {
    host: String,
    port: u16,
    path: String,
    use_tls: bool,
    use_websocket: bool,
}

/// Broker configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerConfig {
    pub id: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl BrokerConfig {
    fn parse_url(&self) -> Result<ParsedUrl, String> {
        let url = &self.url;
        
        // Determine protocol
        let (use_tls, use_websocket, rest) = if let Some(stripped) = url.strip_prefix("wss://") {
            (true, true, stripped)
        } else if let Some(stripped) = url.strip_prefix("ws://") {
            (false, true, stripped)
        } else if let Some(stripped) = url.strip_prefix("mqtts://") {
            (true, false, stripped)
        } else if let Some(stripped) = url.strip_prefix("ssl://") {
            (true, false, stripped)
        } else if let Some(stripped) = url.strip_prefix("mqtt://") {
            (false, false, stripped)
        } else if let Some(stripped) = url.strip_prefix("tcp://") {
            (false, false, stripped)
        } else {
            // Default to mqtt:// if no scheme
            (false, false, url.as_str())
        };

        // Split host:port and path
        let (host_port, path) = if let Some(slash_idx) = rest.find('/') {
            (&rest[..slash_idx], rest[slash_idx..].to_string())
        } else {
            (rest, "/mqtt".to_string())
        };

        // Parse host and port
        let (host, port) = if let Some(colon_idx) = host_port.rfind(':') {
            let host = &host_port[..colon_idx];
            let port_str = &host_port[colon_idx + 1..];
            let port = port_str.parse::<u16>().map_err(|_| format!("Invalid port: {port_str}"))?;
            (host.to_string(), port)
        } else {
            // Default ports
            let default_port = match (use_tls, use_websocket) {
                (true, true) => 443,   // wss
                (false, true) => 80,   // ws
                (true, false) => 8883, // mqtts
                (false, false) => 1883, // mqtt
            };
            (host_port.to_string(), default_port)
        };

        Ok(ParsedUrl {
            host,
            port,
            path,
            use_tls,
            use_websocket,
        })
    }

    #[allow(clippy::unused_self)]
    fn client_id(&self) -> String {
        format!(
            "microflow-{}",
            &uuid::Uuid::new_v4().to_string()[..8]
        )
    }
}

/// A message a client publishes on its session's behalf: just before the
/// session is ended on purpose (the pool's last words), or — left with the
/// broker as the link's will — when the link ends without a goodbye.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastWord {
    pub topic: String,
    pub payload: Vec<u8>,
    pub retain: bool,
}

impl LastWord {
    /// Whether a CONNECT can carry it as a will: a topic without wildcards,
    /// and a topic and payload each within MQTT's two-byte length.
    fn fits_a_will(&self) -> bool {
        let short = usize::from(u16::MAX);
        !self.topic.is_empty() && !self.topic.contains(['+', '#']) && self.topic.len() <= short && self.payload.len() <= short
    }
}

/// Incoming MQTT message
#[derive(Debug, Clone)]
pub struct MqttMessage {
    pub topic: String,
    pub payload: Vec<u8>,
    pub retain: bool,
}

/// Callback type for received messages
pub type MessageCallback = Arc<dyn Fn(MqttMessage) + Send + Sync>;

/// Who holds a subscription on a broker. Several subscribers can hold the same
/// topic filter at once: each has its own callback and gets its own delivery,
/// and what one of them subscribes or unsubscribes never changes what another
/// receives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Subscriber {
    /// The running flow: the subscriptions the `CloudPerformer` keeps for its
    /// subscribe nodes. They end with the broker's session, and the performer
    /// makes them again on the next one.
    Flow,
    /// The Connection Console: the user's own subscriptions on the broker
    /// settings page (`mqtt_subscribe` / `mqtt_unsubscribe`). They stand for
    /// the broker id, across sessions: the pool makes them again on each one
    /// (see [`super::manager`]).
    Console,
}

/// One subscriber's hold on a topic filter.
pub(super) struct Held {
    callback: MessageCallback,
    /// The exact topics this subscriber has had a message on since it last
    /// (re)joined the filter — what decides whether a retained replay is news
    /// to it (see [`route`]).
    ///
    /// **It only grows while the subscription lives**: one entry for a plain
    /// topic, one per distinct topic that ever had a message under a
    /// wildcard, with no upper bound but the broker's topic space. That is
    /// left so on purpose. An entry may be forgotten only when no replay of
    /// its topic can still be on its way to this client, and that moment
    /// cannot be known: a replay follows any SUBSCRIBE of any overlapping
    /// filter by any subscriber, and nothing marks its end. Forgetting early
    /// would deliver an old retained value a second time — to a Counter, a
    /// wrong count — which is the fault the set exists to prevent; keeping it
    /// costs one topic string each, about a megabyte for ten thousand topics.
    /// The set is emptied where a replay to everyone is wanted anyway: on
    /// re-subscribing after a reconnect, and when the subscriber subscribes
    /// again.
    seen: HashSet<String>,
}

impl Held {
    fn new(callback: MessageCallback) -> Self {
        Self { callback, seen: HashSet::new() }
    }
}

/// What a client holds: per topic filter, each subscriber's [`Held`]. A filter
/// is in the map exactly while at least one subscriber holds it.
pub(super) type Subscriptions = HashMap<String, HashMap<Subscriber, Held>>;

/// Make `subscriber` hold `topic` in `subscriptions`, unless it already does.
pub(super) fn hold(subscriptions: &mut Subscriptions, topic: &str, subscriber: Subscriber, callback: MessageCallback) {
    subscriptions.entry(topic.to_string()).or_default().entry(subscriber).or_insert_with(|| Held::new(callback));
}

/// How long after a live message the copies of it a broker may still send for
/// the client's other matching filters are waited for (see [`route`]). A
/// broker writes them out together, one after the other, so they arrive well
/// within it.
pub const COPY_WINDOW: Duration = Duration::from_millis(50);

/// A live message that matched several of the client's filters, and how many
/// more copies of it the broker may still send.
struct Owed {
    payload: Vec<u8>,
    copies: usize,
    until: Instant,
}

/// Per topic, the copies of its last live message a broker may still send.
type Copies = HashMap<String, Owed>;

/// The callbacks an inbound message on `topic` goes to, marking the topic seen
/// for every subscriber of a matching filter. Each subscriber of a filter that
/// matches gets one delivery per message, however many filters match it and
/// however many copies of it the broker sends.
///
/// **Copies.** A message does not say which subscription it is for, and a
/// broker may send one copy of it for each of the client's filters that match
/// its topic (MQTT 3.1.1 §3.3.5, MQTT 5 §3.3.4; mosquitto 2 and EMQX do), or
/// one for all of them (`HiveMQ` does). So the first copy goes to every matching
/// filter, and when `n` filters match, up to `n - 1` more live messages on that
/// topic with the same payload within [`COPY_WINDOW`] of it are taken for its
/// copies and go to nobody. Any other message on the topic ends the wait. At
/// `QoS` 0 nothing else tells a copy from a new message, so this cannot be
/// exact: on a broker that sends one copy, a publisher that repeats a payload
/// within the window loses the repeat to a filter overlap; a copy that comes
/// later than the window is delivered again.
///
/// **Retained messages.** A broker answers every SUBSCRIBE with the retained
/// messages its filter matches, flagged RETAIN, and forwards a live publish to
/// a subscription that already exists unflagged. A flagged message is therefore
/// always a replay that one of this client's own SUBSCRIBEs asked for — and
/// this client sends one whenever a subscriber joins a filter, so that the
/// joiner gets the retained value. The rule that keeps the others from getting
/// it again: **a flagged message goes to a subscriber only if that subscriber
/// has had no message on that exact topic since it joined.** The joiner has had
/// none, so it gets the replay. A subscriber that was already there has had the
/// replay of its own join, or a newer live value, so it does not — and a
/// Counter behind it does not count the same value twice. The rule needs no
/// "replay is over" moment, which a filter with no retained message, or a
/// wildcard with several, never signals. An unflagged message goes to
/// everyone. That also takes care of the flagged copies a broker sends when
/// several overlapping filters are subscribed at once, as on a reconnect.
fn route(
    subscriptions: &mut Subscriptions,
    copies: &mut Copies,
    message: &MqttMessage,
    now: Instant,
) -> Vec<MessageCallback> {
    let MqttMessage { topic, payload, retain } = message;
    if !retain {
        copies.retain(|_, owed| owed.until > now);
        if let Some(owed) = copies.get_mut(topic.as_str()).filter(|owed| owed.payload == *payload) {
            owed.copies -= 1;
            if owed.copies == 0 {
                copies.remove(topic.as_str());
            }
            return Vec::new();
        }
        let filters = subscriptions.keys().filter(|filter| MqttBroker::topic_matches(filter, topic)).count();
        if filters > 1 {
            copies.insert(topic.clone(), Owed { payload: payload.clone(), copies: filters - 1, until: now + COPY_WINDOW });
        } else {
            copies.remove(topic.as_str());
        }
    }
    let mut callbacks = Vec::new();
    for (filter, subscribers) in subscriptions.iter_mut() {
        if !MqttBroker::topic_matches(filter, topic) {
            continue;
        }
        for held in subscribers.values_mut() {
            let news = if held.seen.contains(topic) { !retain } else { held.seen.insert(topic.clone()) };
            if news {
                callbacks.push(Arc::clone(&held.callback));
            }
        }
    }
    callbacks
}

/// The levels a subscription to `filter` matches topics with: `filter`
/// without its shared-subscription prefix, or `None` when it is not a valid
/// filter (MQTT 3.1.1 §4.7.1, MQTT 5 §4.8.2).
fn matching_filter(filter: &str) -> Option<Vec<&str>> {
    let plain = if let Some(rest) = filter.strip_prefix("$share/") {
        let (group, plain) = rest.split_once('/')?;
        if group.is_empty() || group.contains(['+', '#']) {
            return None;
        }
        plain
    } else {
        filter.strip_prefix("$queue/").unwrap_or(filter)
    };
    if plain.is_empty() || plain.contains('\0') {
        return None;
    }
    let levels: Vec<&str> = plain.split('/').collect();
    let last = levels.len() - 1;
    let valid = levels
        .iter()
        .enumerate()
        .all(|(index, level)| !level.contains(['+', '#']) || *level == "+" || (*level == "#" && index == last));
    valid.then_some(levels)
}

/// Internal state for the broker connection
struct BrokerState {
    status: ConnectionStatus,
    subscriptions: Subscriptions,
    /// The copies of a live message the broker may still send ([`route`]).
    copies: Copies,
    /// [`MqttBroker::disconnect`] was called: this client is finished and its
    /// reconnect loop must not bring it back.
    closed: bool,
    /// What every link this client opens leaves with the broker as its will
    /// ([`MqttBroker::set_will`]).
    will: Option<LastWord>,
    /// Called whenever `status` changes ([`MqttBroker::on_status_change`]).
    status_changed: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl BrokerState {
    /// The one place the status is written, so that every change is told.
    fn set_status(&mut self, status: ConnectionStatus) {
        if self.status == status {
            return;
        }
        self.status = status;
        if let Some(notify) = &self.status_changed {
            notify();
        }
    }
}

/// Why a receive loop is told to stop.
enum Stop {
    /// The client was disconnected: it is finished.
    Closed,
    /// A write to the link stalled: the link is as good as dropped, and is
    /// repaired as one that dropped.
    Stalled,
}

/// MQTT Broker client
pub struct MqttBroker {
    config: BrokerConfig,
    state: Arc<RwLock<BrokerState>>,
    endpoint: Option<Arc<ClientEndpoint>>,
    shutdown_tx: Option<mpsc::Sender<Stop>>,
    /// Configuration for automatic reconnection with exponential backoff
    reconnect_config: ReconnectConfig,
    /// Called when the reconnect loop has brought a dropped link back up and
    /// re-subscribed what the client holds.
    link_restored: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl MqttBroker {
    #[must_use]
    pub fn new(config: BrokerConfig) -> Self {
        Self::with_reconnect_config(config, ReconnectConfig::default())
    }

    /// Create a new `MqttBroker` with custom reconnection configuration
    #[must_use]
    pub fn with_reconnect_config(config: BrokerConfig, reconnect_config: ReconnectConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(BrokerState {
                status: ConnectionStatus::Disconnected,
                subscriptions: HashMap::new(),
                copies: HashMap::new(),
                closed: false,
                will: None,
                status_changed: None,
            })),
            endpoint: None,
            shutdown_tx: None,
            reconnect_config,
            link_restored: None,
        }
    }

    /// Call `notify` each time this client repairs a dropped link by itself.
    #[must_use]
    pub fn on_link_restored(mut self, notify: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.link_restored = Some(notify);
        self
    }

    /// Call `notify` each time this client's [status](Self::status) changes.
    /// It is called with the client's state locked: it must return at once and
    /// must not ask the client anything.
    #[must_use]
    pub fn on_status_change(mut self, notify: Arc<dyn Fn() + Send + Sync>) -> Self {
        // A client that is still being built is the state's only holder.
        if let Some(state) = Arc::get_mut(&mut self.state) {
            state.get_mut().status_changed = Some(notify);
        }
        self
    }

    /// Connect to the MQTT broker
    /// 
    /// This method must be called on an Arc<`RwLock`<MqttBroker>> to enable
    /// automatic reconnection when the connection is lost.
    pub async fn connect(broker: Arc<RwLock<Self>>) -> Result<(), String> {
        let dialer = broker.read().await.dialer().await;
        let endpoint = dialer.dial().await?;

        let mut broker_guard = broker.write().await;
        if !broker_guard.install(endpoint).await {
            return Err("Disconnected while connecting".to_string());
        }
        broker_guard.start_receive_loop(broker.clone());
        Ok(())
    }

    /// What it takes to open a link for this client, without the client:
    /// the link carries the client's will as it is now.
    async fn dialer(&self) -> Dialer {
        Dialer {
            config: self.config.clone(),
            state: self.state.clone(),
            timeout: self.reconnect_config.connect_timeout,
            will: self.state.read().await.will.clone(),
        }
    }

    /// Make `will` what this client's links leave with the broker as their
    /// will: the message the broker publishes for the client should the link
    /// end without a DISCONNECT — the app crashed, the machine lost power,
    /// the network went. One that no CONNECT can carry is no will.
    ///
    /// A link carries the will it was opened with. Returns whether the link
    /// that is up carries another one now, and is to be
    /// [renewed](Self::renew_link); a link that is down carries the new one
    /// when it is repaired.
    pub(super) async fn set_will(&self, will: Option<LastWord>) -> bool {
        let will = will.filter(LastWord::fits_a_will);
        let mut state = self.state.write().await;
        if state.will == will {
            return false;
        }
        state.will = will;
        state.status == ConnectionStatus::Connected && !state.closed
    }

    /// Replace the link that is up with one that carries the client's will
    /// ([`Self::set_will`]), without the session noticing: the new link is
    /// opened while the old one is still up, takes over every subscription,
    /// and then the old one says DISCONNECT — which tells the broker to drop
    /// the old will, not publish it. The client stays `Connected` throughout.
    ///
    /// The receive loop of the old link stops before the new one starts, so
    /// nothing arrives twice; a message published in that moment is lost, as
    /// one published while a link is down is. A subscriber is not handed a
    /// retained message again that it has had: the new link's replay of it
    /// is not news.
    ///
    /// Gives up, and leaves the old link as it is, when the new one cannot be
    /// opened, when the old one dropped meanwhile (its repair carries the
    /// will), when the client was disconnected, and when the will changed
    /// again meanwhile (the renewal for that one carries it).
    pub(super) async fn renew_link(broker: Arc<RwLock<Self>>) {
        let dialer = broker.read().await.dialer().await;
        let endpoint = match dialer.open().await {
            Ok(endpoint) => endpoint,
            Err(e) => {
                log::warn!("[MQTT] Broker {}: no new link for its will: {e}", dialer.config.id);
                return;
            }
        };

        let mut client = broker.write().await;
        let still = {
            let state = client.state.read().await;
            !state.closed && state.status == ConnectionStatus::Connected && state.will == dialer.will
        };
        if !still {
            let _ = endpoint.close().await;
            return;
        }
        if let Some(stop) = client.shutdown_tx.take() {
            let _ = stop.send(Stop::Closed).await;
        }
        let old = client.endpoint.replace(Arc::new(endpoint));
        client.start_receive_loop(broker.clone());
        if let Err(e) = client.subscribe_held().await {
            log::warn!("[MQTT] Broker {}: the renewed link did not take every subscription: {e}", client.config.id);
        }
        let write_timeout = client.reconnect_config.write_timeout;
        let id = client.config.id.clone();
        drop(client);

        if let Some(old) = old {
            if let Ok(disconnect) = mqtt_ep::packet::v5_0::Disconnect::builder()
                .reason_code(mqtt_ep::result_code::DisconnectReasonCode::NormalDisconnection)
                .build()
            {
                let _ = tokio::time::timeout(write_timeout, old.send(disconnect)).await;
            }
            let _ = old.close().await;
        }
        log::info!("[MQTT] Broker {id}: link renewed for its will");
    }

    /// Make the link a [`Dialer`] opened this client's link: from here on the
    /// client is `Connected`. Returns `false`, having closed the link, when the
    /// client was disconnected while the link was being opened.
    async fn install(&mut self, endpoint: ClientEndpoint) -> bool {
        let mut state = self.state.write().await;
        if state.closed {
            state.set_status(ConnectionStatus::Disconnected);
            drop(state);
            let _ = endpoint.close().await;
            return false;
        }
        state.set_status(ConnectionStatus::Connected);
        drop(state);

        self.endpoint = Some(Arc::new(endpoint));
        log::info!("[MQTT] Connected to broker {}", self.config.id);
        true
    }

    /// Start the receive loop on the link [`Self::install`] just took, and
    /// keep the handle that shuts it down. `broker` is this client, for the
    /// reconnect loop the receive loop starts when the link drops.
    fn start_receive_loop(&mut self, broker: Arc<RwLock<Self>>) {
        let Some(endpoint) = self.endpoint.clone() else {
            log::error!("[MQTT] No endpoint for receive loop");
            return;
        };
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        self.shutdown_tx = Some(shutdown_tx);
        spawn_receive_loop(endpoint, self.state.clone(), shutdown_rx, broker, self.reconnect_config.clone());
    }
}

/// Opens one link to a broker: the transport, CONNECT, and the wait for
/// CONNACK, bounded by `timeout`.
///
/// It carries its own copy of what an attempt needs, so that the attempt runs
/// **without the client's lock**. An attempt can take as long as the timeout,
/// and everything that asks about the client meanwhile — its status, its
/// session, a subscribe that will be refused — takes that lock: held across
/// the attempt, a broker that does not answer would stall every reconcile and
/// every `flow_update` for the length of the timeout, again at each retry.
/// The client is locked only to take the finished link
/// (`MqttBroker::install`).
struct Dialer {
    config: BrokerConfig,
    state: Arc<RwLock<BrokerState>>,
    timeout: Duration,
    /// The will the link is opened with.
    will: Option<LastWord>,
}

impl Dialer {
    /// One connection attempt. The client is `Connecting` while it runs and
    /// `Error` when it fails — which includes not being through in time; on
    /// success the link is returned for the client to install.
    async fn dial(&self) -> Result<ClientEndpoint, String> {
        self.state.write().await.set_status(ConnectionStatus::Connecting);
        let attempt = self.open().await;
        if attempt.is_err() {
            self.state.write().await.set_status(ConnectionStatus::Error);
        }
        attempt
    }

    /// One connection attempt, bounded as [`Self::dial`]'s, that leaves the
    /// client's status alone: for a link opened beside one that is up.
    async fn open(&self) -> Result<ClientEndpoint, String> {
        match tokio::time::timeout(self.timeout, self.handshake()).await {
            Ok(attempt) => attempt,
            Err(_) => Err(format!("Broker {} did not answer within {:?}", self.config.id, self.timeout)),
        }
    }

    /// Open the transport, send CONNECT and wait for a CONNACK that accepts.
    async fn handshake(&self) -> Result<ClientEndpoint, String> {
        let parsed = self.config.parse_url()?;
        log::info!(
            "[MQTT] Connecting to {}:{} (tls={}, ws={})",
            parsed.host,
            parsed.port,
            parsed.use_tls,
            parsed.use_websocket
        );

        let endpoint = ClientEndpoint::new(mqtt_ep::Version::V5_0);
        let addr = format!("{}:{}", parsed.host, parsed.port);

        // Connect based on transport type
        match (parsed.use_websocket, parsed.use_tls) {
            (true, true) => {
                self.connect_wss(&endpoint, &addr, &parsed.host, &parsed.path)
                    .await
            }
            (true, false) => {
                self.connect_ws(&endpoint, &addr, &parsed.host, &parsed.path)
                    .await
            }
            (false, true) => self.connect_tls(&endpoint, &addr, &parsed.host).await,
            (false, false) => self.connect_tcp(&endpoint, &addr).await,
        }?;

        // Send CONNECT packet
        self.send_connect(&endpoint).await?;

        // Wait for CONNACK
        match endpoint.recv().await {
            Ok(mqtt_ep::packet::Packet::V5_0Connack(connack)) => {
                if connack.reason_code() == mqtt_ep::result_code::ConnectReasonCode::Success {
                    Ok(endpoint)
                } else {
                    Err(format!("CONNACK failed: {:?}", connack.reason_code()))
                }
            }
            Ok(_) => Err("Unexpected packet, expected CONNACK".to_string()),
            Err(e) => Err(format!("Failed to receive CONNACK: {e}")),
        }
    }

    async fn connect_tcp(&self, endpoint: &ClientEndpoint, addr: &str) -> Result<(), String> {
        let tcp_stream = mqtt_ep::transport::connect_helper::connect_tcp(addr, None)
            .await
            .map_err(|e| format!("TCP connect failed: {e}"))?;

        let transport = mqtt_ep::transport::TcpTransport::from_stream(tcp_stream);

        endpoint
            .attach(transport, mqtt_ep::endpoint::Mode::Client)
            .await
            .map_err(|e| format!("Failed to attach transport: {e}"))
    }

    async fn connect_tls(
        &self,
        endpoint: &ClientEndpoint,
        addr: &str,
        host: &str,
    ) -> Result<(), String> {
        let tls_stream =
            mqtt_ep::transport::connect_helper::connect_tcp_tls(addr, host, None, None)
                .await
                .map_err(|e| format!("TLS connect failed: {e}"))?;

        let transport = mqtt_ep::transport::TlsTransport::from_stream(tls_stream);

        endpoint
            .attach(transport, mqtt_ep::endpoint::Mode::Client)
            .await
            .map_err(|e| format!("Failed to attach TLS transport: {e}"))
    }

    async fn connect_ws(
        &self,
        endpoint: &ClientEndpoint,
        addr: &str,
        host: &str,
        path: &str,
    ) -> Result<(), String> {
        // Plain WS is not well supported by the library, upgrade to WSS
        // Most MQTT brokers use TLS anyway for security
        log::warn!("[MQTT] Plain WebSocket (ws://) requested, but using WSS for better compatibility");
        self.connect_wss(endpoint, addr, host, path).await
    }

    async fn connect_wss(
        &self,
        endpoint: &ClientEndpoint,
        addr: &str,
        host: &str,
        path: &str,
    ) -> Result<(), String> {
        let wss_stream =
            mqtt_ep::transport::connect_helper::connect_tcp_tls_ws(addr, host, path, None, None, None)
                .await
                .map_err(|e| format!("WSS connect failed: {e}"))?;

        let transport = mqtt_ep::transport::WebSocketTransport::from_tls_client_stream(wss_stream);

        endpoint
            .attach(transport, mqtt_ep::endpoint::Mode::Client)
            .await
            .map_err(|e| format!("Failed to attach WSS transport: {e}"))
    }

    async fn send_connect(&self, endpoint: &ClientEndpoint) -> Result<(), String> {
        let mut builder = mqtt_ep::packet::v5_0::Connect::builder()
            .client_id(self.config.client_id())
            .map_err(|e| format!("Invalid client ID: {e:?}"))?
            .keep_alive(60)
            .clean_start(true);

        if let Some(will) = &self.will {
            builder = builder
                .will_message(will.topic.as_str(), &will.payload, mqtt_ep::packet::Qos::AtMostOnce, will.retain)
                .map_err(|e| format!("Invalid will: {e:?}"))?;
        }

        if let (Some(username), Some(password)) = (&self.config.username, &self.config.password) {
            builder = builder
                .user_name(username)
                .map_err(|e| format!("Invalid username: {e:?}"))?
                .password(password.as_bytes().to_vec())
                .map_err(|e| format!("Invalid password: {e:?}"))?;
        }

        let connect = builder
            .build()
            .map_err(|e| format!("Failed to build CONNECT: {e:?}"))?;

        endpoint
            .send(connect)
            .await
            .map_err(MqttBroker::format_connection_error)
    }
}

impl MqttBroker {
    /// Receive loop that handles incoming MQTT packets
    ///
    /// When the link is lost — a receive fails, or a write to it stalled
    /// ([`Stop::Stalled`]) — this loop:
    /// 1. Updates status to Disconnected
    /// 2. Spawns the `reconnect_loop` to attempt automatic reconnection
    ///
    /// # Requirements
    /// - 1.1: Initiates automatic reconnection when connection is lost
    async fn receive_loop(
        endpoint: Arc<ClientEndpoint>,
        state: Arc<RwLock<BrokerState>>,
        mut shutdown_rx: mpsc::Receiver<Stop>,
        broker: Arc<RwLock<MqttBroker>>,
        reconnect_config: ReconnectConfig,
    ) {
        loop {
            let lost = tokio::select! {
                stop = shutdown_rx.recv() => match stop {
                    Some(Stop::Stalled) => "a write to the link stalled".to_string(),
                    Some(Stop::Closed) | None => {
                        log::info!("[MQTT] Receive loop shutdown");
                        return;
                    }
                },
                result = endpoint.recv() => match result {
                    Ok(packet) => {
                        Self::handle_packet(packet, &state).await;
                        continue;
                    }
                    Err(e) => e.to_string(),
                },
            };
            log::error!("[MQTT] Link lost: {lost}");

            // Update status to Disconnected before starting reconnection
            state.write().await.set_status(ConnectionStatus::Disconnected);

            // Spawn reconnect_loop to attempt automatic reconnection (Requirement 1.1)
            // Use spawn_reconnect_loop helper to avoid type cycle
            spawn_reconnect_loop(broker.clone(), reconnect_config.clone(), state.clone());
            return;
        }
    }

    /// The link, if it is up. A link that dropped, or stalled, takes no
    /// writes: they would fail, or stall in turn.
    async fn link(&self) -> Result<&Arc<ClientEndpoint>, String> {
        if self.state.read().await.status != ConnectionStatus::Connected {
            return Err("Not connected".to_string());
        }
        self.endpoint.as_ref().ok_or_else(|| "Not connected".to_string())
    }

    /// One write to the link, given the write timeout
    /// ([`ReconnectConfig::write_timeout`]). A write that is not through in
    /// time has failed, and its link is treated as dropped from here on: the
    /// client is `Disconnected`, further writes are refused at once, and the
    /// receive loop is told to start the reconnect.
    ///
    /// A writer holds the client (for reading) for the length of its write,
    /// and a new link is installed with the client held for writing: the link
    /// that is given up here is the one the write was on.
    async fn write<T>(&self, writing: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
        let timeout = self.reconnect_config.write_timeout;
        if let Ok(written) = tokio::time::timeout(timeout, writing).await {
            return written;
        }
        log::warn!("[MQTT] A write to broker {} was not through within {timeout:?}: its link stalled", self.config.id);
        self.link_stalled().await;
        Err(format!("Not connected: the link to broker {} stalled", self.config.id))
    }

    /// The link takes no more writes: treat it as dropped. The client is
    /// `Disconnected` from here on, and its receive loop starts the reconnect.
    pub(super) async fn link_stalled(&self) {
        self.state.write().await.set_status(ConnectionStatus::Disconnected);
        if let Some(stop) = &self.shutdown_tx {
            // Full means the loop has been told already.
            let _ = stop.try_send(Stop::Stalled);
        }
    }

    async fn handle_packet(packet: mqtt_ep::packet::Packet, state: &Arc<RwLock<BrokerState>>) {
        match packet {
            mqtt_ep::packet::Packet::V5_0Publish(publish) => {
                let message = MqttMessage {
                    topic: publish.topic_name().to_string(),
                    payload: publish.payload().as_slice().to_vec(),
                    retain: publish.retain(),
                };

                // Every subscriber the message is for gets its own copy
                // (`route`); the callbacks run with the state lock released.
                let callbacks = {
                    let mut state = state.write().await;
                    let state = &mut *state;
                    route(&mut state.subscriptions, &mut state.copies, &message, Instant::now())
                };
                for callback in callbacks {
                    callback(message.clone());
                }
            }
            mqtt_ep::packet::Packet::V5_0Pingresp(_) => {
                log::trace!("[MQTT] Received PINGRESP");
            }
            mqtt_ep::packet::Packet::V5_0Suback(suback) => {
                log::debug!("[MQTT] Received SUBACK: {suback:?}");
            }
            mqtt_ep::packet::Packet::V5_0Unsuback(unsuback) => {
                log::debug!("[MQTT] Received UNSUBACK: {unsuback:?}");
            }
            mqtt_ep::packet::Packet::V5_0Disconnect(disconnect) => {
                log::info!(
                    "[MQTT] Received DISCONNECT: {:?}",
                    disconnect.reason_code()
                );
                state.write().await.set_status(ConnectionStatus::Disconnected);
            }
            _ => {
                log::debug!("[MQTT] Received packet: {packet:?}");
            }
        }
    }

    /// Whether a subscription to `filter` delivers messages on `topic`. The
    /// browser host's `topicMatches` (`src/cloud/topic-filter.ts`) is the
    /// same rule; both are held to `src/cloud/fixtures/topic-filter.json`.
    ///
    /// - `+` fills a whole level and matches exactly one level.
    /// - `#` is the last level, alone, and matches the parent level and
    ///   everything below it.
    /// - A topic that starts with `$` (`$SYS/…`) is not matched by a filter
    ///   that starts with a wildcard.
    /// - A shared subscription (`$share/<group>/<filter>`, `$queue/<filter>`)
    ///   is matched by the filter after its group: the broker delivers on the
    ///   plain topic.
    /// - An invalid filter, or a topic that is not a [topic
    ///   name](Self::is_topic_name), matches nothing: a broker refuses the one
    ///   and never delivers on the other.
    #[must_use]
    pub fn topic_matches(filter: &str, topic: &str) -> bool {
        let Some(filter_levels) = matching_filter(filter) else { return false };
        if !Self::is_topic_name(topic) {
            return false;
        }
        if topic.starts_with('$') && matches!(filter_levels.first(), Some(&("#" | "+"))) {
            return false;
        }
        let mut topic_levels = topic.split('/');
        for level in filter_levels {
            if level == "#" {
                return true;
            }
            match topic_levels.next() {
                Some(name) if level == "+" || level == name => {}
                _ => return false,
            }
        }
        topic_levels.next().is_none()
    }

    /// Whether `topic` can be published on: at least one character, no
    /// wildcard and no NUL (MQTT 3.1.1 §4.7.3, §1.5.3).
    #[must_use]
    pub fn is_topic_name(topic: &str) -> bool {
        !topic.is_empty() && !topic.contains(['+', '#', '\0'])
    }

    /// Disconnect from the broker. Final: the client forgets its subscriptions
    /// and a reconnect loop still running for it stops instead of reconnecting.
    pub async fn disconnect(&mut self) -> Result<(), String> {
        self.retire().await;
        Ok(())
    }

    /// Disconnect as [`Self::disconnect`] does, and hand back the subscriptions
    /// the client held — for the client that takes over from this one
    /// ([`Self::adopt`]).
    pub(super) async fn retire(&mut self) -> Subscriptions {
        // First: a reconnect loop waiting on this client's lock must find it
        // closed.
        let link_up = {
            let mut state = self.state.write().await;
            state.closed = true;
            state.status == ConnectionStatus::Connected
        };

        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(Stop::Closed).await;
        }

        // The DISCONNECT is for a link that is up, and gets the time any
        // write gets: a link that stalls under it is left as it is.
        if let Some(endpoint) = self.endpoint.take().filter(|_| link_up) {
            let disconnect = mqtt_ep::packet::v5_0::Disconnect::builder()
                .reason_code(mqtt_ep::result_code::DisconnectReasonCode::NormalDisconnection)
                .build();
            match disconnect {
                Ok(disconnect) => {
                    let _ = tokio::time::timeout(self.reconnect_config.write_timeout, endpoint.send(disconnect)).await;
                }
                Err(e) => log::warn!("[MQTT] Failed to build DISCONNECT: {e:?}"),
            }
        }

        let mut state = self.state.write().await;
        state.set_status(ConnectionStatus::Disconnected);

        log::info!("[MQTT] Disconnected from broker {}", self.config.id);
        std::mem::take(&mut state.subscriptions)
    }

    /// Take over the subscriptions of a client this one replaces, and subscribe
    /// their filters on this connection.
    pub(super) async fn adopt(&self, subscriptions: Subscriptions) -> Result<(), String> {
        self.state.write().await.subscriptions = subscriptions;
        self.resubscribe_all().await
    }

    /// Get current connection status
    pub async fn status(&self) -> ConnectionStatus {
        self.state.read().await.status
    }

    /// Subscribe `subscriber` to a topic filter, replacing the callback it
    /// already had for it. A SUBSCRIBE goes to the broker every time — also
    /// when another subscriber holds the filter already — because that is what
    /// makes the broker replay the filter's retained messages for the one that
    /// joins; `route` keeps the replay from the others. On failure the client
    /// holds what it held before.
    ///
    /// `Ok` means the SUBSCRIBE was written to the link, not that the broker
    /// granted it: a refusal in the SUBACK is logged, not reported.
    pub async fn subscribe(
        &self,
        topic: &str,
        subscriber: Subscriber,
        callback: MessageCallback,
    ) -> Result<(), String> {
        // Held before the SUBSCRIBE goes out, so the replay it triggers cannot
        // arrive ahead of the subscriber it is for.
        let previous = {
            let mut state = self.state.write().await;
            state.subscriptions.entry(topic.to_string()).or_default().insert(subscriber, Held::new(callback))
        };

        if let Err(e) = self.send_subscribe(topic).await {
            let mut state = self.state.write().await;
            if let Some(subscribers) = state.subscriptions.get_mut(topic) {
                match previous {
                    Some(held) => {
                        subscribers.insert(subscriber, held);
                    }
                    None => {
                        subscribers.remove(&subscriber);
                    }
                }
                if subscribers.is_empty() {
                    state.subscriptions.remove(topic);
                }
            }
            return Err(e);
        }

        log::info!("[MQTT] Subscribed {subscriber:?} to topic: {topic}");
        Ok(())
    }

    /// Unsubscribe `subscriber` from a topic filter. The UNSUBSCRIBE goes to
    /// the broker only when it was the last subscriber holding the filter; on
    /// failure it still holds it. A filter it does not hold is not an error.
    pub async fn unsubscribe(&self, topic: &str, subscriber: Subscriber) -> Result<(), String> {
        let others = {
            let state = self.state.read().await;
            match state.subscriptions.get(topic) {
                Some(subscribers) if subscribers.contains_key(&subscriber) => subscribers.len() - 1,
                _ => return Ok(()),
            }
        };
        if others == 0 {
            self.send_unsubscribe(topic).await?;
        }

        let mut state = self.state.write().await;
        if let Some(subscribers) = state.subscriptions.get_mut(topic) {
            subscribers.remove(&subscriber);
            if subscribers.is_empty() {
                state.subscriptions.remove(topic);
            }
        }

        log::info!("[MQTT] Unsubscribed {subscriber:?} from topic: {topic}");
        Ok(())
    }

    /// End `subscriber`'s hold on a topic filter whatever the link is doing —
    /// for a subscriber that will not ask again. The hold ends here: nothing
    /// is delivered to it any more, and a filter nobody else holds is not
    /// subscribed again when the link comes back. The UNSUBSCRIBE for such a
    /// filter is sent if the link takes it. Should it not get through on a
    /// link that is up, the broker keeps sending the filter's messages until
    /// the connection ends, and they are routed to nobody.
    pub async fn release(&self, topic: &str, subscriber: Subscriber) {
        let last = {
            let mut state = self.state.write().await;
            let Some(subscribers) = state.subscriptions.get_mut(topic) else { return };
            if subscribers.remove(&subscriber).is_none() {
                return;
            }
            let last = subscribers.is_empty();
            if last {
                state.subscriptions.remove(topic);
            }
            last
        };
        log::info!("[MQTT] Released {subscriber:?} from topic: {topic}");
        if last {
            if let Err(e) = self.send_unsubscribe(topic).await {
                log::info!("[MQTT] Topic {topic} was let go of without an UNSUBSCRIBE: {e}");
            }
        }
    }

    /// Write an UNSUBSCRIBE for `topic` to the link.
    async fn send_unsubscribe(&self, topic: &str) -> Result<(), String> {
        let endpoint = self.link().await?;

        self.write(async {
            // Acquire packet ID from the endpoint's internal pool
            let packet_id = endpoint.acquire_packet_id().await.map_err(Self::format_connection_error)?;

            let unsubscribe = mqtt_ep::packet::v5_0::Unsubscribe::builder()
                .packet_id(packet_id)
                .entries(vec![topic.to_string()])
                .map_err(|e| format!("Invalid topic: {e:?}"))?
                .build()
                .map_err(|e| format!("Failed to build UNSUBSCRIBE: {e:?}"))?;

            endpoint.send(unsubscribe).await.map_err(Self::format_connection_error)
        })
        .await
    }

    /// Publish a message to a topic
    pub async fn publish(&self, topic: &str, payload: &[u8], retain: bool) -> Result<(), String> {
        let endpoint = self.link().await?;

        let publish = mqtt_ep::packet::v5_0::Publish::builder()
            .topic_name(topic)
            .map_err(|e| format!("Invalid topic: {e:?}"))?
            .payload(payload)
            .retain(retain)
            .build()
            .map_err(|e| format!("Failed to build PUBLISH: {e:?}"))?;

        self.write(async { endpoint.send(publish).await.map_err(Self::format_connection_error) }).await?;

        log::debug!("[MQTT] Published to topic: {topic}");
        Ok(())
    }

    fn format_connection_error(e: mqtt_ep::connection_error::ConnectionError) -> String {
        match e {
            mqtt_ep::connection_error::ConnectionError::NotConnected => "Not connected".to_string(),
            mqtt_ep::connection_error::ConnectionError::Transport(e) => {
                format!("Transport error: {e}")
            }
            mqtt_ep::connection_error::ConnectionError::Mqtt(e) => {
                format!("MQTT protocol error: {e:?}")
            }
            e => format!("Connection error: {e}"),
        }
    }

    /// Write a SUBSCRIBE for `topic` to the link. The callbacks are not its
    /// concern: a new subscription stores one after this, a reconnection
    /// already holds them.
    async fn send_subscribe(&self, topic: &str) -> Result<(), String> {
        let endpoint = self.link().await?;

        self.write(async {
            // Acquire packet ID from the endpoint's internal pool
            let packet_id = endpoint.acquire_packet_id().await.map_err(Self::format_connection_error)?;

            let sub_entry = mqtt_ep::packet::SubEntry::new(topic, mqtt_ep::packet::SubOpts::new())
                .map_err(|e| format!("Invalid topic: {e:?}"))?;

            let subscribe = mqtt_ep::packet::v5_0::Subscribe::builder()
                .packet_id(packet_id)
                .entries(vec![sub_entry])
                .build()
                .map_err(|e| format!("Failed to build SUBSCRIBE: {e:?}"))?;

            endpoint.send(subscribe).await.map_err(Self::format_connection_error)
        })
        .await
    }

    /// Subscribe every topic filter the client holds again — once per filter,
    /// however many subscribers share it. Used after reconnection to restore
    /// subscriptions. Every subscriber starts over as if it had just joined:
    /// the new connection replays the retained messages, and each of them gets
    /// that replay once.
    pub async fn resubscribe_all(&self) -> Result<(), String> {
        for held in self.state.write().await.subscriptions.values_mut().flat_map(HashMap::values_mut) {
            held.seen.clear();
        }
        self.subscribe_held().await
    }

    /// Subscribe every topic filter the client holds on the link, once per
    /// filter, leaving what each subscriber has had as it is.
    async fn subscribe_held(&self) -> Result<(), String> {
        let topics: Vec<String> = self.state.read().await.subscriptions.keys().cloned().collect();
        for topic in topics {
            self.send_subscribe(&topic).await?;
            log::info!("[MQTT] Resubscribed to topic: {topic}");
        }
        Ok(())
    }

    /// Reconnection loop with exponential backoff
    ///
    /// This function implements automatic reconnection when the MQTT connection is lost.
    /// It uses exponential backoff to avoid overwhelming the broker with reconnection attempts.
    ///
    /// # Arguments
    /// * `broker` - Arc-wrapped `RwLock` to the `MqttBroker` instance
    /// * `config` - `ReconnectConfig` with backoff parameters
    /// * `_state` - Arc-wrapped `RwLock` to the `BrokerState` (reserved for future use)
    ///
    /// # Requirements
    /// - 1.1: Initiates automatic reconnection when connection is lost
    /// - 1.6: Waits for current delay before retrying on failure
    /// - 1.9: Stops reconnecting when `max_attempts` is reached
    /// - 1.11: Resets delay to `initial_delay` on success (handled by new `receive_loop`)
    /// - 1.12: Logs each attempt with delay and attempt number
    async fn reconnect_loop(
        broker: Arc<RwLock<MqttBroker>>,
        config: ReconnectConfig,
        _state: Arc<RwLock<BrokerState>>,
    ) {
        let mut delay = config.initial_delay;
        let mut attempts = 0;

        loop {
            // Check max attempts before attempting reconnection (Requirement 1.9)
            if let Some(max) = config.max_attempts {
                if attempts >= max {
                    log::error!(
                        "[MQTT] Max reconnection attempts ({max}) reached, giving up"
                    );
                    break;
                }
            }

            // Log the reconnection attempt with delay and attempt number (Requirement 1.12)
            log::info!(
                "[MQTT] Reconnecting in {:?} (attempt {})",
                delay,
                attempts + 1
            );

            // Wait for the current delay before retrying (Requirement 1.6)
            tokio::time::sleep(delay).await;

            // Attempt reconnection — unless the client was disconnected while
            // this loop slept. The attempt itself runs without the client's
            // lock (see `Dialer`).
            let dialer = {
                let broker_guard = broker.read().await;
                if broker_guard.state.read().await.closed {
                    log::info!("[MQTT] Broker {} was disconnected; not reconnecting", broker_guard.config.id);
                    return;
                }
                broker_guard.dialer().await
            };

            // When it succeeds, restore the client in one hold of its lock:
            // take the link, start its receive loop, and re-subscribe.
            // `disconnect` takes that lock too, so it lands either before all
            // of this (the link is closed again and the loop stops) or after
            // it (the client is whole, and is shut down as any other).
            let result = match dialer.dial().await {
                Ok(endpoint) => {
                    let mut broker_guard = broker.write().await;
                    if !broker_guard.install(endpoint).await {
                        log::info!("[MQTT] Broker {} was disconnected; not reconnecting", broker_guard.config.id);
                        return;
                    }
                    log::info!("[MQTT] Reconnected successfully");

                    // The new link's receive loop first: a write that stalls
                    // while the topics are made again tells this loop, which
                    // repairs the link as any other (Requirement 1.11: the
                    // delay starts over).
                    broker_guard.start_receive_loop(broker.clone());

                    // Resubscribe to all topics (Requirement 1.10)
                    if let Err(e) = broker_guard.resubscribe_all().await {
                        log::warn!("[MQTT] Failed to resubscribe: {e}");
                    }

                    // Told only when the link is still up: one that went
                    // down again is being repaired, and is told about then.
                    let up = broker_guard.state.read().await.status == ConnectionStatus::Connected;
                    Ok(broker_guard.link_restored.clone().filter(|_| up))
                }
                Err(e) => Err(e),
            };

            match result {
                Ok(link_restored) => {
                    // Last, with the client's lock released: whoever is told
                    // may call straight back into this client.
                    if let Some(notify) = link_restored {
                        notify();
                    }

                    break;
                }
                Err(e) => {
                    log::warn!("[MQTT] Reconnection failed: {e}");
                    attempts += 1;
                    // Apply exponential backoff on failure (Requirement 1.7, 1.8)
                    delay = config.next_delay(delay);
                }
            }
        }
    }
}

/// Helper function to spawn the receive loop
/// This is a free function to break the type cycle between `receive_loop` and `reconnect_loop`
fn spawn_receive_loop(
    endpoint: Arc<ClientEndpoint>,
    state: Arc<RwLock<BrokerState>>,
    shutdown_rx: mpsc::Receiver<Stop>,
    broker: Arc<RwLock<MqttBroker>>,
    reconnect_config: ReconnectConfig,
) {
    tokio::spawn(async move {
        MqttBroker::receive_loop(endpoint, state, shutdown_rx, broker, reconnect_config).await;
    });
}

/// Helper function to spawn the reconnect loop
/// This is a free function to break the type cycle between `receive_loop` and `reconnect_loop`
fn spawn_reconnect_loop(
    broker: Arc<RwLock<MqttBroker>>,
    config: ReconnectConfig,
    state: Arc<RwLock<BrokerState>>,
) {
    tokio::spawn(async move {
        MqttBroker::reconnect_loop(broker, config, state).await;
    });
}
