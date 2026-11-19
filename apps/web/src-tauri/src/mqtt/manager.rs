//! MQTT Manager
//!
//! Manages multiple broker connections with connection pooling.
//! Ensures only one connection per broker is maintained.
//!
//! **The last settings win.** [`MqttManager::connect`] gives the pool a
//! broker's settings, [`MqttManager::disconnect`] and [`MqttManager::remove`]
//! withdraw them, and [`MqttManager::sync`] gives it the whole list. Whatever
//! it was told last about a broker id is what the pool ends up with, in
//! whatever order the connection attempts it started on the way finish: an
//! attempt whose settings were replaced or withdrawn is given up, its link is
//! closed, and it is never put in the pool.
//!
//! Each broker the pool holds is in one **broker session** ([`BrokerSession`]):
//! it starts when a `connect` first connects the broker and ends when the
//! broker is disconnected or given different settings. The flow's
//! subscriptions belong to the session: they survive a dropped link — whether
//! the client repairs it by itself or a `connect` does it sooner — and end
//! with the session, so the `CloudPerformer`, which tracks them, keys them on
//! the session id and makes them again on the next one.
//!
//! The Connection Console's subscriptions belong to the **broker id** instead.
//! Nothing re-makes them for the console, and its list of subscribed topics
//! outlives a config edit or a disconnect, so the pool keeps them: they are
//! made again on every session that comes up for that broker id, and end only
//! when the console unsubscribes — which it can at any time, whatever the
//! link is doing —, when the broker is [removed](MqttManager::remove) from the
//! pool, or when the page that made them is gone
//! ([`MqttManager::forget_console`]).
//!
//! [`MqttManager::changes`] ticks whenever a session starts, ends, or gets its
//! link back, so a subscriber can catch up on what it could not do before
//! without every caller of `connect` / `disconnect` having to tell it.

use super::broker::{
    hold, BrokerConfig, ConnectionStatus, LastWord, MessageCallback, MqttBroker, ReconnectConfig, Subscriber,
    Subscriptions,
};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, watch, RwLock};

/// One broker session in the pool, as [`MqttManager::session`] reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrokerSession {
    /// Unique per session: a broker that is disconnected and connected again,
    /// or connected with a changed config, comes back under a new id, having
    /// forgotten every flow subscription of the old one.
    pub id: u64,
    /// Whether the link is up right now. A session whose link dropped stays in
    /// the pool, reconnects by itself and re-subscribes what it holds.
    pub online: bool,
    /// Tells the session's links apart: a new number each time its link comes
    /// up — the session starting, or its link repaired — and the same number
    /// for as long as that link lasts. Whoever told the broker something can
    /// tell from it whether the broker may have lost it since: a broker that
    /// restarted, or that another client spoke to while this one was away,
    /// no longer holds what it was told on an earlier link.
    pub link: u64,
}

/// Whether two configs reach the same broker with the same credentials.
fn same_connection(a: &BrokerConfig, b: &BrokerConfig) -> bool {
    a.url == b.url && a.username == b.username && a.password == b.password
}

/// How long a session's last words may take to write, all of them together:
/// 2 seconds. They are written to a link that was up a moment ago, which takes
/// milliseconds; a link that has stalled since must not hold up the end of the
/// session, and the `connect` on new settings that waits for it.
pub const LAST_WORDS_TIMEOUT: Duration = Duration::from_secs(2);

/// Internal broker entry with config and client
struct BrokerEntry {
    config: BrokerConfig,
    broker: Arc<RwLock<MqttBroker>>,
    /// The [`BrokerSession::id`] of this connection.
    session: u64,
    /// The [`BrokerSession::link`] of the link up now, or of the last one.
    link: Arc<AtomicU64>,
    /// What to publish before the session is ended on purpose.
    last_words: Vec<LastWord>,
}

/// The pool's clients, by broker id.
type Brokers = HashMap<String, Arc<tokio::sync::Mutex<BrokerEntry>>>;

/// A session the pool no longer holds, and whose client is still to be closed
/// — with the pool unlocked, so that what its link does holds up nothing else.
struct Ended(Arc<tokio::sync::Mutex<BrokerEntry>>);

/// How long [`MqttManager::disconnect_all`] is given when the app quits: the
/// sessions say their last words at once, each within [`LAST_WORDS_TIMEOUT`],
/// and this leaves their DISCONNECTs half a second on top. A link that is not
/// through by then is left to the operating system to close, and its broker
/// publishes the session's will ([`MqttManager::set_last_words`]).
pub const QUIT_GRACE: Duration = Duration::from_millis(2500);

impl Ended {
    /// Say the session's last words, if its link is up, and close its client.
    async fn close(self) {
        let entry = self.0.lock().await;
        if !entry.last_words.is_empty() {
            let client = entry.broker.read().await;
            if client.status().await == ConnectionStatus::Connected {
                let saying = async {
                    for word in &entry.last_words {
                        client.publish(&word.topic, &word.payload, word.retain).await?;
                    }
                    Ok::<(), String>(())
                };
                match tokio::time::timeout(LAST_WORDS_TIMEOUT, saying).await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => log::warn!("[MQTT Manager] Broker {} did not take its last words: {e}", entry.config.id),
                    Err(_) => {
                        log::warn!("[MQTT Manager] Broker {} took too long over its last words", entry.config.id);
                        // No DISCONNECT is waited for on it either.
                        client.link_stalled().await;
                    }
                }
            }
        }
        entry.broker.write().await.retire().await;
    }
}

/// Every broker's status at one moment, and its number
/// ([`MqttManager::status_snapshot`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatusSnapshot {
    pub seq: u64,
    pub statuses: Vec<(String, ConnectionStatus)>,
}

/// How a connection attempt ended; `None` while it runs.
type Outcome = Option<Result<(), String>>;

/// The settings the pool was last given for one broker id, and the attempt to
/// connect as they say.
struct Wanted {
    /// Tells these settings from the ones the id had before and the ones it
    /// gets after: an attempt carries the generation it was started for, and
    /// goes into the pool only if that is still the id's generation.
    generation: u64,
    config: BrokerConfig,
    /// The attempt that is opening a link for these settings right now.
    dialing: Option<Dialing>,
    /// The last attempt for these settings ended without the broker being
    /// connected, and none has been started since.
    failed: bool,
    /// What [`MqttManager::stretch`] answers: renewed each time the broker
    /// comes up with these settings.
    stretch: u64,
}

/// A `connect` that is opening a link. Whoever asks for the same settings
/// meanwhile waits for this one's outcome instead of opening a second link
/// beside it.
struct Dialing {
    /// Tells this attempt from a later one for the same settings.
    token: u64,
    outcome: watch::Receiver<Outcome>,
    /// Dropped with this record — which is when the settings are replaced or
    /// withdrawn — and that is what tells the attempt to give up.
    _given_up: oneshot::Sender<()>,
}

/// What the pool was told about its brokers: the settings of each, by broker
/// id. An id without an entry is not to be connected.
#[derive(Default)]
struct Settings {
    brokers: HashMap<String, Wanted>,
    /// The generations and attempt tokens handed out so far.
    issued: u64,
}

impl Settings {
    fn issue(&mut self) -> u64 {
        self.issued += 1;
        self.issued
    }

    /// `config`'s broker came up — a session started for it, or its link is
    /// back: a new stretch begins, if these are still its settings.
    fn came_up(&mut self, config: &BrokerConfig) {
        let stretch = self.issue();
        if let Some(wanted) = self.brokers.get_mut(&config.id).filter(|wanted| same_connection(&wanted.config, config)) {
            wanted.stretch = stretch;
        }
    }
}

/// Takes an attempt off its settings when it ends — or is dropped unfinished —
/// and notes there how it ended.
struct InFlight {
    settings: Arc<Mutex<Settings>>,
    broker_id: String,
    token: u64,
    /// Whether the attempt left the broker connected. An attempt that is
    /// dropped unfinished did not.
    connected: bool,
    status_changes: watch::Sender<u64>,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        let mut settings = self.settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(wanted) = settings.brokers.get_mut(&self.broker_id) {
            if wanted.dialing.as_ref().is_some_and(|dialing| dialing.token == self.token) {
                wanted.dialing = None;
                wanted.failed = !self.connected;
            }
        }
        drop(settings);
        MqttManager::changed(&self.status_changes);
    }
}

/// What a `connect` does about a broker that is not up.
enum Attempt {
    /// Somebody is already opening this connection: wait for how it ends.
    Join(watch::Receiver<Outcome>),
    /// Open it, and tell whoever joins how it ended. The receiver resolves
    /// when the settings the attempt is for are replaced or withdrawn.
    Own(watch::Sender<Outcome>, oneshot::Receiver<()>, InFlight),
}

/// What a `connect` answers when the settings it was called with are no longer
/// the broker's: they were replaced or withdrawn while it was connecting.
fn superseded(broker_id: &str) -> String {
    format!("The settings of broker {broker_id} changed before it was connected with these")
}

/// The lists [`MqttManager::sync`] was given: applied one at a time, and only
/// the newest.
#[derive(Default)]
struct Syncs {
    /// How many lists were received.
    received: AtomicU64,
    /// Held while a list is applied.
    turn: tokio::sync::Mutex<()>,
}

/// Manages multiple MQTT broker connections
#[derive(Clone)]
pub struct MqttManager {
    brokers: Arc<RwLock<Brokers>>,
    /// The id the next session gets.
    next_session: Arc<AtomicU64>,
    /// The [`BrokerSession::link`]s handed out so far.
    links: Arc<AtomicU64>,
    /// Counts the changes [`Self::changes`] reports.
    changes: watch::Sender<u64>,
    /// The Connection Console's subscriptions: `broker id → topic → callback`.
    /// Kept beside the clients, not in them, because they outlive a session.
    /// Read and written only while holding `brokers`, so a console subscribe
    /// and a `connect` cannot miss each other.
    console: Arc<Mutex<HashMap<String, HashMap<String, MessageCallback>>>>,
    /// How each client repairs a dropped link.
    reconnect: ReconnectConfig,
    /// What the pool was last told about each broker id. Never held across an
    /// `await`. An attempt that has its link takes `brokers` for writing and
    /// then looks here, and whatever replaces or withdraws settings changes
    /// them here before it touches `brokers`: so an attempt either sees that
    /// its settings are gone, or is in the pool before they go.
    settings: Arc<Mutex<Settings>>,
    syncs: Arc<Syncs>,
    /// The sessions a settings sync removed, still saying their last words,
    /// by broker id: each resolves to `true` once its session is closed. A
    /// `connect` of that broker id waits for it before it dials.
    closing: Arc<Mutex<HashMap<String, watch::Receiver<bool>>>>,
    /// Ticks whenever a broker's [status](Self::status) may have changed.
    status_changes: watch::Sender<u64>,
    /// The last [`StatusSnapshot`] taken; held while one is taken.
    snapshots: Arc<tokio::sync::Mutex<StatusSnapshot>>,
}

impl MqttManager {
    #[must_use]
    pub fn new() -> Self {
        Self::with_reconnect_config(ReconnectConfig::default())
    }

    /// A pool whose clients repair a dropped link as `reconnect` says.
    #[must_use]
    pub fn with_reconnect_config(reconnect: ReconnectConfig) -> Self {
        Self {
            brokers: Arc::new(RwLock::new(HashMap::new())),
            next_session: Arc::new(AtomicU64::new(1)),
            links: Arc::new(AtomicU64::new(0)),
            changes: watch::channel(0).0,
            console: Arc::new(Mutex::new(HashMap::new())),
            reconnect,
            settings: Arc::new(Mutex::new(Settings::default())),
            syncs: Arc::new(Syncs::default()),
            closing: Arc::new(Mutex::new(HashMap::new())),
            snapshots: Arc::new(tokio::sync::Mutex::new(StatusSnapshot::default())),
            status_changes: watch::channel(0).0,
        }
    }

    fn console(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashMap<String, MessageCallback>>> {
        self.console.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn settings(&self) -> std::sync::MutexGuard<'_, Settings> {
        self.settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn closing(&self) -> std::sync::MutexGuard<'_, HashMap<String, watch::Receiver<bool>>> {
        self.closing.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Close `ended`, `broker_id`'s session, on a task of its own: whoever
    /// ended it does not wait. A session of the same broker id that is still
    /// closing from before is closed first, and a `connect` of the broker id
    /// waits for both ([`Self::closed`]).
    fn close_later(&self, broker_id: &str, ended: Ended) {
        let (done, closed) = watch::channel(false);
        let before = self.closing().insert(broker_id.to_string(), closed.clone());
        let (closing, broker_id) = (Arc::clone(&self.closing), broker_id.to_string());
        tokio::spawn(async move {
            if let Some(mut before) = before {
                let _ = before.wait_for(|closed| *closed).await;
            }
            ended.close().await;
            done.send_replace(true);
            let mut closing = closing.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if closing.get(&broker_id).is_some_and(|last| last.same_channel(&closed)) {
                closing.remove(&broker_id);
            }
        });
    }

    /// Resolves once no session of `broker_id` is still closing on a task of
    /// its own ([`Self::close_later`]).
    async fn closed(&self, broker_id: &str) {
        let closing = self.closing().get(broker_id).cloned();
        if let Some(mut closing) = closing {
            let _ = closing.wait_for(|closed| *closed).await;
        }
    }

    /// Ticks whenever a broker session started, ended, or got its link back —
    /// the moments at which a subscription that could not be made (or dropped)
    /// before can be now, and at which subscriptions tracked against a session
    /// may have gone stale. The value is a counter; only the tick matters.
    #[must_use]
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn changed(changes: &watch::Sender<u64>) {
        changes.send_modify(|count| *count += 1);
    }

    /// Connect a broker as `config` says: from this call on, these are the
    /// settings of the broker id. **They are the broker's settings as soon as
    /// the call is made**, in the order of the calls; the returned future does
    /// the connecting and says how it went.
    ///
    /// A broker that is connected, or connecting by itself, with these
    /// settings is left as it is. One whose link is down is connected afresh
    /// rather than left to its own reconnect backoff, which repairs its
    /// session: the new client takes over every subscription the old one
    /// held, under the same session id, and the old client is closed — left
    /// alone, its reconnect loop would bring it back beside the new one and
    /// deliver every message a second time.
    ///
    /// A broker that is in the pool with other settings has its session ended
    /// first, before the new host is tried: it is not left running on settings
    /// nobody sees any more, however long the attempt takes and however it
    /// ends. The session the new settings start holds none of the flow's
    /// subscriptions.
    ///
    /// Whatever session comes up, the console's subscriptions for this broker
    /// id are made on it.
    ///
    /// The attempt takes as long as the broker takes to answer, up to the
    /// connect timeout, and the pool is not locked while it runs: every other
    /// broker, and every question about this one, is served meanwhile. A
    /// second `connect` with the same settings while one is opening the link
    /// does not open another: it waits for the first and returns what that
    /// returns.
    ///
    /// **`Ok` means the broker is connected as `config` says** (or connecting
    /// by itself). When the settings are replaced or withdrawn before that —
    /// another `connect`, a [`Self::disconnect`], a [`Self::remove`], a
    /// [`Self::sync`] — the attempt is given up at once, the link it was
    /// opening is closed, and the answer is an error.
    pub fn connect(&self, config: BrokerConfig) -> impl Future<Output = Result<(), String>> + Send + 'static {
        let generation = self.want(&config);
        let pool = self.clone();
        async move { pool.bring_up(config, generation).await }
    }

    /// Make `config` the settings of its broker id, and return their
    /// generation. Settings that reach the same broker with the same
    /// credentials as the ones the id has are the same settings: their
    /// generation, and the attempt in flight for them, stand.
    fn want(&self, config: &BrokerConfig) -> u64 {
        let mut settings = self.settings();
        if let Some(wanted) = settings.brokers.get(&config.id).filter(|wanted| same_connection(&wanted.config, config)) {
            return wanted.generation;
        }
        let generation = settings.issue();
        // Replacing the record drops the attempt of the old settings, which
        // gives it up.
        let wanted = Wanted { generation, config: config.clone(), dialing: None, failed: false, stretch: generation };
        settings.brokers.insert(config.id.clone(), wanted);
        drop(settings);
        Self::changed(&self.status_changes);
        generation
    }

    /// Withdraw the settings of `broker_id`: it is not to be connected, and an
    /// attempt in flight for it is given up.
    fn unwant(&self, broker_id: &str) {
        let withdrawn = self.settings().brokers.remove(broker_id);
        if withdrawn.is_some() {
            Self::changed(&self.status_changes);
        }
    }

    /// A number that changes when `broker_id` gets other settings and each
    /// time it comes up with the ones it has — a session starts for it, or its
    /// link is back — and at no other time. `None` while the pool has no
    /// settings for the broker.
    ///
    /// Two answers that agree were given within one stretch of the broker
    /// being down (or up) on the same settings: whoever waited for it to come
    /// up in that stretch, and gave up, has no reason to wait again.
    #[must_use]
    pub fn stretch(&self, broker_id: &str) -> Option<u64> {
        self.settings().brokers.get(broker_id).map(|wanted| wanted.stretch)
    }

    /// Whether `generation` is still the generation of `broker_id`'s settings.
    fn is_wanted(&self, broker_id: &str, generation: u64) -> bool {
        self.settings().brokers.get(broker_id).is_some_and(|wanted| wanted.generation == generation)
    }

    /// Bring the broker up as `config` — the settings of `generation` — says.
    async fn bring_up(&self, config: BrokerConfig, generation: u64) -> Result<(), String> {
        // What the pool holds for this broker id: nothing, a client on these
        // settings, or one on others.
        let held = Self::status_of(&*self.brokers.read().await, &config).await;
        match held {
            Some(Some(ConnectionStatus::Connected | ConnectionStatus::Connecting)) => {
                // At debug: a settings sync asks this of every broker, on
                // every keystroke of an edit.
                log::debug!("[MQTT Manager] Broker {} already connected", config.id);
                return Ok(());
            }
            Some(None) => self.end_session_on_other_settings(&config, generation).await?,
            Some(Some(_)) | None => {}
        }

        // A session of this broker id that a settings sync ended may still
        // be saying its last words: the new one is not opened beside it,
        // where what it announces could be followed by those.
        self.closed(&config.id).await;

        match self.attempt(&config.id, generation) {
            None => Err(superseded(&config.id)),
            Some(Attempt::Join(mut outcome)) => match outcome.wait_for(Option::is_some).await {
                Ok(outcome) => outcome.clone().unwrap_or(Ok(())),
                Err(_) => Err(format!("The connect to broker {} was abandoned", config.id)),
            },
            Some(Attempt::Own(outcome, given_up, mut in_flight)) => {
                let result = self.open_session(config, generation, given_up).await;
                in_flight.connected = result.is_ok();
                // Off its settings before anybody is told how it ended: who
                // asks for the status then finds the outcome, not the attempt.
                drop(in_flight);
                outcome.send_replace(Some(result.clone()));
                result
            }
        }
    }

    /// Join the attempt in flight for the settings of `generation`, or become
    /// it. `None` when those are no longer the broker's settings.
    fn attempt(&self, broker_id: &str, generation: u64) -> Option<Attempt> {
        let mut settings = self.settings();
        let token = settings.issue();
        let wanted = settings.brokers.get_mut(broker_id).filter(|wanted| wanted.generation == generation)?;
        if let Some(dialing) = &wanted.dialing {
            return Some(Attempt::Join(dialing.outcome.clone()));
        }
        let (outcome, theirs) = watch::channel(None);
        let (stand, given_up) = oneshot::channel();
        wanted.dialing = Some(Dialing { token, outcome: theirs, _given_up: stand });
        wanted.failed = false;
        drop(settings);
        Self::changed(&self.status_changes);
        let in_flight = InFlight {
            settings: Arc::clone(&self.settings),
            broker_id: broker_id.to_string(),
            token,
            connected: false,
            status_changes: self.status_changes.clone(),
        };
        Some(Attempt::Own(outcome, given_up, in_flight))
    }

    /// End the session the pool holds for `config`'s broker id on settings
    /// other than `config` — unless `config` is itself no longer what the
    /// broker is to be connected with, which is an error.
    async fn end_session_on_other_settings(&self, config: &BrokerConfig, generation: u64) -> Result<(), String> {
        let ended = {
            let mut brokers = self.brokers.write().await;
            if !self.is_wanted(&config.id, generation) {
                return Err(superseded(&config.id));
            }
            if Self::status_of(&brokers, config).await == Some(None) {
                log::info!("[MQTT Manager] Broker {} has new settings: ending its session", config.id);
                self.end_session(&mut brokers, &config.id)
            } else {
                None
            }
        };
        if let Some(ended) = ended {
            ended.close().await;
        }
        Ok(())
    }

    /// Open a link for `config` — the settings of `generation` — and make it
    /// the broker's session in the pool. `given_up` resolves when those stop
    /// being the broker's settings.
    async fn open_session(
        &self,
        config: BrokerConfig,
        generation: u64,
        given_up: oneshot::Receiver<()>,
    ) -> Result<(), String> {
        // Create new broker connection wrapped in Arc<RwLock<>>
        let (changes, status_changes) = (self.changes.clone(), self.status_changes.clone());
        let (settings, restored) = (Arc::clone(&self.settings), config.clone());
        let (link, links) = (Arc::new(AtomicU64::new(0)), Arc::clone(&self.links));
        let restored_link = Arc::clone(&link);
        let client = MqttBroker::with_reconnect_config(config.clone(), self.reconnect.clone())
            .on_link_restored(Arc::new(move || {
                restored_link.store(links.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner).came_up(&restored);
                Self::changed(&changes);
            }))
            .on_status_change(Arc::new(move || Self::changed(&status_changes)));
        // A link that repairs a session carries the session's will from the
        // start.
        client.set_will(self.will_of(&config).await).await;
        let broker = Arc::new(RwLock::new(client));

        // The attempt is dropped where it stands when its settings go: a link
        // that is half open closes with it, and nothing waits out the connect
        // timeout for a host nobody wants any more.
        let connected = tokio::select! {
            connected = MqttBroker::connect(broker.clone()) => Some(connected),
            _ = given_up => None,
        };
        let Some(connected) = connected else {
            broker.write().await.retire().await;
            return Err(superseded(&config.id));
        };
        connected?;

        let mut brokers = self.brokers.write().await;

        // The settings may have gone in the moment between the link coming up
        // and the pool being locked. Checked with the pool locked: whoever
        // replaces or withdraws them after this look comes to the pool once
        // this session is in it, finds it there, and ends it.
        if !self.is_wanted(&config.id, generation) {
            drop(brokers);
            broker.write().await.retire().await;
            return Err(superseded(&config.id));
        }

        // While that link was being opened the broker may have come up some
        // other way: its own client repaired itself. One connection per
        // broker: this one is not needed.
        if Self::status_of(&brokers, &config).await == Some(Some(ConnectionStatus::Connected)) {
            broker.write().await.retire().await;
            return Ok(());
        }
        self.settings().came_up(&config);

        // What the new client starts out holding: everything of the client it
        // replaces when this is the same session, and the console's
        // subscriptions for this broker id in any case.
        let mut session = self.next_session.fetch_add(1, Ordering::Relaxed);
        let mut held = Subscriptions::new();
        let mut last_words = Vec::new();
        if let Some(old) = brokers.remove(&config.id) {
            let mut old_guard = old.lock().await;
            let retired = old_guard.broker.write().await.retire().await;
            if same_connection(&old_guard.config, &config) {
                session = old_guard.session;
                held = retired;
                last_words = std::mem::take(&mut old_guard.last_words);
            }
        }
        if let Some(topics) = self.console().get(&config.id) {
            for (topic, callback) in topics {
                hold(&mut held, topic, Subscriber::Console, Arc::clone(callback));
            }
        }
        // Held by the client before the SUBSCRIBEs go out: should one fail,
        // the client's own reconnect makes it again.
        if !held.is_empty() {
            if let Err(e) = broker.read().await.adopt(held).await {
                log::warn!("[MQTT Manager] Broker {} could not re-subscribe: {e}", config.id);
            }
        }
        // The session's words may have changed while the link was opened.
        if broker.read().await.set_will(last_words.first().cloned()).await {
            tokio::spawn(MqttBroker::renew_link(Arc::clone(&broker)));
        }

        link.store(self.links.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
        let entry = BrokerEntry { config, broker, session, link, last_words };
        brokers.insert(entry.config.id.clone(), Arc::new(tokio::sync::Mutex::new(entry)));
        drop(brokers);

        Self::changed(&self.changes);
        Self::changed(&self.status_changes);
        Ok(())
    }

    /// The will of the session the pool holds for `config`'s broker id on
    /// these settings: the first of its last words.
    async fn will_of(&self, config: &BrokerConfig) -> Option<LastWord> {
        let brokers = self.brokers.read().await;
        let entry_guard = brokers.get(&config.id)?.lock().await;
        if !same_connection(&entry_guard.config, config) {
            return None;
        }
        entry_guard.last_words.first().cloned()
    }

    /// What `brokers` holds for `config`'s broker id: `None` for nothing,
    /// `Some(None)` for a client on other settings than `config` — which is
    /// not this connection, whatever state it is in — and otherwise the
    /// status of the client that connects the way `config` says.
    async fn status_of(brokers: &Brokers, config: &BrokerConfig) -> Option<Option<ConnectionStatus>> {
        let entry_guard = brokers.get(&config.id)?.lock().await;
        if !same_connection(&entry_guard.config, config) {
            return Some(None);
        }
        let status = entry_guard.broker.read().await.status().await;
        Some(Some(status))
    }

    /// Disconnect from a broker: its settings are withdrawn, and an attempt to
    /// connect it that is in flight is given up. Its session ends, and the
    /// flow's subscriptions with it; the console's stand, for the next
    /// `connect` of this broker id.
    ///
    /// A session that ends here, or because the broker was
    /// [removed](Self::remove) or given other settings, is ended on purpose:
    /// if its link is up it first publishes its [last
    /// words](Self::set_last_words), then says DISCONNECT.
    pub async fn disconnect(&self, broker_id: &str) -> Result<(), String> {
        self.unwant(broker_id);
        let ended = {
            let mut brokers = self.brokers.write().await;
            self.end_session_unless_wanted_again(&mut brokers, broker_id)
        };
        if let Some(ended) = ended {
            ended.close().await;
        }
        Ok(())
    }

    /// Take a broker out of the pool for good — it was deleted from the
    /// settings. Disconnects it and drops the console's subscriptions for its
    /// id, which nothing would ever unsubscribe.
    pub async fn remove(&self, broker_id: &str) -> Result<(), String> {
        if let Some(ended) = self.take_out(broker_id).await {
            ended.close().await;
        }
        Ok(())
    }

    /// [`Self::remove`], up to closing the session it ends: that is the
    /// caller's.
    async fn take_out(&self, broker_id: &str) -> Option<Ended> {
        self.unwant(broker_id);
        let mut brokers = self.brokers.write().await;
        self.console().remove(broker_id);
        self.end_session_unless_wanted_again(&mut brokers, broker_id)
    }

    /// End `broker_id`'s session for a `disconnect` that withdrew its
    /// settings — unless a `connect` gave it settings again while this waited
    /// for the pool: then that call came last, and what the pool holds is its
    /// business.
    fn end_session_unless_wanted_again(&self, brokers: &mut Brokers, broker_id: &str) -> Option<Ended> {
        if self.settings().brokers.contains_key(broker_id) {
            return None;
        }
        self.end_session(brokers, broker_id)
    }

    /// Take `broker_id`'s session out of `brokers`: from here on the pool does
    /// not hold it, and says so. Its client is the caller's to
    /// [close](Ended::close), once the pool is unlocked.
    fn end_session(&self, brokers: &mut Brokers, broker_id: &str) -> Option<Ended> {
        let entry = brokers.remove(broker_id)?;
        Self::changed(&self.changes);
        Self::changed(&self.status_changes);
        Some(Ended(entry))
    }

    /// Disconnect every broker — the app quits. Every session ends on
    /// purpose, all at once: each says its last words, if its link is up, and
    /// DISCONNECT. Resolves once every session is closed, the ones a settings
    /// sync was still closing included; a link that stalls holds up only its
    /// own session, which is why the app gives this [`QUIT_GRACE`].
    pub async fn disconnect_all(&self) -> Result<(), String> {
        self.settings().brokers.clear();
        let ended: Vec<Ended> = self.brokers.write().await.drain().map(|(_, entry)| Ended(entry)).collect();
        Self::changed(&self.changes);
        Self::changed(&self.status_changes);

        let still_closing: Vec<watch::Receiver<bool>> = self.closing().values().cloned().collect();
        let mut closing = tokio::task::JoinSet::new();
        for session in ended {
            closing.spawn(session.close());
        }
        for mut session in still_closing {
            closing.spawn(async move {
                let _ = session.wait_for(|closed| *closed).await;
            });
        }
        while closing.join_next().await.is_some() {}
        Ok(())
    }

    /// Leave `words` with `broker_id`'s session `session`: what it publishes
    /// just before it is ended on purpose — the broker is disconnected,
    /// removed, or given other settings, or the app quits — if its link is up
    /// then. They replace what was left before; an empty list leaves nothing.
    /// A session whose link is down when it ends says nothing. Ignored when
    /// `session` is no longer the broker's session.
    ///
    /// The words stay with the session for as long as it lasts, across a
    /// repaired link. Saying them is bounded ([`LAST_WORDS_TIMEOUT`]) and
    /// happens with the pool unlocked.
    ///
    /// **The first of them is also the session's will**: every link of the
    /// session leaves it with the broker, which publishes it should the link
    /// end without a goodbye — the app crashed or ran out of its
    /// [`QUIT_GRACE`], the machine lost power, the network went. MQTT gives
    /// a link one will, and fixes it when the link is opened: a link that is
    /// up and carries another one is replaced by one that carries this
    /// ([`MqttBroker::renew_link`]), on a task of its own, without the
    /// session ending or its link going down.
    pub async fn set_last_words(&self, broker_id: &str, session: u64, words: Vec<LastWord>) {
        let brokers = self.brokers.read().await;
        let Some(entry) = brokers.get(broker_id) else { return };
        let mut entry_guard = entry.lock().await;
        if entry_guard.session != session {
            return;
        }
        let will = words.first().cloned();
        entry_guard.last_words = words;
        let client = Arc::clone(&entry_guard.broker);
        if client.read().await.set_will(will).await {
            tokio::spawn(MqttBroker::renew_link(client));
        }
    }

    /// The broker settings are now `configs`, all of them: every broker in the
    /// list is connected as it says ([`Self::connect`]), all at once, and
    /// every broker the pool knows that is not in it is [removed](Self::remove).
    ///
    /// **The last list given is the truth.** Lists are numbered as the calls
    /// are made and applied one at a time; a list that finds a newer one
    /// received by the time its turn comes is not applied at all. Applying a
    /// list waits for no broker to answer: the future resolves once the pool
    /// has been told, with the connects carrying on by themselves, so a broker
    /// that does not answer holds up neither the others nor the next list.
    /// Nor does a removed broker whose link takes long over its last words:
    /// they are said on a task of their own, and a later list that adds the
    /// broker id again has it dialled once they have been.
    pub fn sync(&self, configs: Vec<BrokerConfig>) -> impl Future<Output = ()> + Send + 'static {
        let call = self.syncs.received.fetch_add(1, Ordering::SeqCst) + 1;
        let pool = self.clone();
        async move {
            let _turn = pool.syncs.turn.lock().await;
            if pool.syncs.received.load(Ordering::SeqCst) != call {
                log::debug!("[MQTT Manager] Broker list {call} was replaced before it was applied");
                return;
            }

            let listed: HashSet<&str> = configs.iter().map(|config| config.id.as_str()).collect();
            for id in pool.all_broker_ids().await {
                if !listed.contains(id.as_str()) {
                    log::info!("[MQTT Manager] Removing broker {id}: it is no longer in the settings");
                    if let Some(ended) = pool.take_out(&id).await {
                        pool.close_later(&id, ended);
                    }
                }
            }

            for config in configs {
                let id = config.id.clone();
                // The settings are the broker's from here; connecting is not
                // waited for.
                let connecting = pool.connect(config);
                tokio::spawn(async move {
                    if let Err(e) = connecting.await {
                        log::error!("[MQTT Manager] Failed to connect broker {id}: {e}");
                    }
                });
            }
        }
    }

    /// The status of a broker, as its settings page shows it:
    ///
    /// - `Connecting` while a `connect` is opening a link for it — the first
    ///   one included, when the pool holds no client for it yet — or is about
    ///   to, and while its client is repairing a dropped link by itself;
    /// - `Connected` while its link is up;
    /// - `Error` when the last attempt to connect it failed, and nothing has
    ///   been tried since;
    /// - `Disconnected` when its link dropped and the next attempt has not
    ///   started, and for a broker the pool has no settings for.
    pub async fn status(&self, broker_id: &str) -> ConnectionStatus {
        let brokers = self.brokers.read().await;
        self.status_in(&brokers, broker_id).await
    }

    /// [`Self::status`], with the pool locked by the caller.
    async fn status_in(&self, brokers: &Brokers, broker_id: &str) -> ConnectionStatus {
        // `(an attempt is in flight, the last one failed)`, for a broker that
        // has settings.
        let wanted = self.settings().brokers.get(broker_id).map(|wanted| (wanted.dialing.is_some(), wanted.failed));
        if let Some((true, _)) = wanted {
            return ConnectionStatus::Connecting;
        }
        if let Some(entry) = brokers.get(broker_id) {
            let entry_guard = entry.lock().await;
            let broker_guard = entry_guard.broker.read().await;
            return broker_guard.status().await;
        }
        match wanted {
            Some((_, true)) => ConnectionStatus::Error,
            // Settings, and nothing tried for them yet: a `connect` is on its
            // way to.
            Some((_, false)) => ConnectionStatus::Connecting,
            None => ConnectionStatus::Disconnected,
        }
    }

    /// Ticks whenever the [status](Self::status) of a broker may have changed.
    /// The value is a counter; only the tick matters, and a tick does not
    /// promise a change.
    #[must_use]
    pub fn status_changes(&self) -> watch::Receiver<u64> {
        self.status_changes.subscribe()
    }

    /// Call `report` with a [snapshot](Self::status_snapshot) of every
    /// broker's status each time the status of one of them changed, from this
    /// call on, for as long as the returned future is polled. Nothing is
    /// reported twice under one number, and a status that changed and changed
    /// back between two looks is not reported at all — unless another
    /// snapshot was taken in between: that one may have shown the change, and
    /// whoever got it is then told it is over.
    pub async fn report_statuses(&self, mut report: impl FnMut(&StatusSnapshot)) {
        // Subscribed before the first look: no change after it is missed.
        let mut changes = self.status_changes();
        let mut reported = self.status_snapshot().await.seq;
        while changes.changed().await.is_ok() {
            let snapshot = self.status_snapshot().await;
            if snapshot.seq != reported {
                report(&snapshot);
                reported = snapshot.seq;
            }
        }
    }

    /// [Every broker's status](Self::all_statuses) as it is now, numbered:
    /// the number goes up each time a snapshot differs from the one taken
    /// before it, and only then. Snapshots are taken one at a time, so of two,
    /// the one with the higher number shows the later state, and two with one
    /// number show the same. Whoever is handed snapshots by several ways —
    /// the reply to a settings sync and the status event, which can arrive in
    /// either order — keeps the one with the highest number.
    pub async fn status_snapshot(&self) -> StatusSnapshot {
        let mut last = self.snapshots.lock().await;
        let statuses = self.all_statuses().await;
        if statuses != last.statuses {
            last.seq += 1;
            last.statuses = statuses;
        }
        last.clone()
    }

    /// The broker's session in the pool, or `None` when the pool holds no
    /// connection for it.
    pub async fn session(&self, broker_id: &str) -> Option<BrokerSession> {
        let brokers = self.brokers.read().await;
        let entry = brokers.get(broker_id)?;
        let entry_guard = entry.lock().await;
        let broker_guard = entry_guard.broker.read().await;
        Some(BrokerSession {
            id: entry_guard.session,
            online: matches!(broker_guard.status().await, ConnectionStatus::Connected),
            link: entry_guard.link.load(Ordering::SeqCst),
        })
    }

    /// Whether the pool holds no client for `broker_id` that connects the way
    /// `new_config` says.
    pub async fn config_changed(&self, broker_id: &str, new_config: &BrokerConfig) -> bool {
        let brokers = self.brokers.read().await;

        if let Some(entry) = brokers.get(broker_id) {
            let entry_guard = entry.lock().await;
            !same_connection(&entry_guard.config, new_config)
        } else {
            true // No existing config means it's "changed"
        }
    }

    /// Every broker id the pool knows: the ones it holds a client for, the
    /// ones it has settings for — connected or not, a broker that is still
    /// being dialled for the first time included — and the ones the console
    /// holds a subscription for. All of them are brokers a settings sync must
    /// be able to remove.
    pub async fn all_broker_ids(&self) -> Vec<String> {
        let brokers = self.brokers.read().await;
        let mut ids: HashSet<String> = brokers.keys().cloned().collect();
        ids.extend(self.settings().brokers.keys().cloned());
        ids.extend(self.console().keys().cloned());
        let mut ids: Vec<String> = ids.into_iter().collect();
        ids.sort();
        ids
    }

    /// The [status](Self::status) of every broker the pool has settings or a
    /// client for, ordered by broker id.
    pub async fn all_statuses(&self) -> Vec<(String, ConnectionStatus)> {
        let brokers = self.brokers.read().await;
        let mut ids: Vec<String> = self.settings().brokers.keys().cloned().collect();
        ids.extend(brokers.keys().cloned());
        ids.sort();
        ids.dedup();

        let mut statuses = Vec::with_capacity(ids.len());
        for id in ids {
            let status = self.status_in(&brokers, &id).await;
            statuses.push((id, status));
        }
        statuses
    }

    /// Subscribe `subscriber` to a topic filter on a broker, with its own
    /// callback; other subscribers of the same filter are untouched
    /// ([`Subscriber`]). Returns the id of the [`BrokerSession`] that now holds
    /// the subscription. A console subscription that was made stands for the
    /// broker id from here on (see the module docs).
    pub async fn subscribe(
        &self,
        broker_id: &str,
        topic: &str,
        subscriber: Subscriber,
        callback: MessageCallback,
    ) -> Result<u64, String> {
        let brokers = self.brokers.read().await;

        let entry = brokers
            .get(broker_id)
            .ok_or_else(|| format!("Broker {broker_id} not connected"))?;

        let entry_guard = entry.lock().await;
        let broker_guard = entry_guard.broker.read().await;
        broker_guard.subscribe(topic, subscriber, Arc::clone(&callback)).await?;
        if subscriber == Subscriber::Console {
            self.console().entry(broker_id.to_string()).or_default().insert(topic.to_string(), callback);
        }
        Ok(entry_guard.session)
    }

    /// Unsubscribe `subscriber` from a topic filter on a broker. Other
    /// subscribers of the same filter keep receiving.
    ///
    /// **The flow** keeps what the broker could not let go of: on failure —
    /// the broker is not in the pool, its link is down — the subscription is
    /// still held, and the flow, which tracks it, tries again.
    ///
    /// **The console** asks once and does not look at the answer, so its
    /// subscription ends here whatever the broker is doing: it stands no
    /// longer, nothing is delivered for it any more, and no session that
    /// comes up makes it again. The broker is told when its link is up. The
    /// answer is an error only when there was nothing to end: the pool holds
    /// no client for the broker, and nothing stood for the topic.
    pub async fn unsubscribe(&self, broker_id: &str, topic: &str, subscriber: Subscriber) -> Result<(), String> {
        let brokers = self.brokers.read().await;
        let entry = brokers.get(broker_id);

        if subscriber == Subscriber::Console {
            let stood = {
                let mut console = self.console();
                let stood = console.get_mut(broker_id).is_some_and(|topics| topics.remove(topic).is_some());
                if console.get(broker_id).is_some_and(HashMap::is_empty) {
                    console.remove(broker_id);
                }
                stood
            };
            return match entry {
                Some(entry) => {
                    entry.lock().await.broker.read().await.release(topic, subscriber).await;
                    Ok(())
                }
                None if stood => Ok(()),
                None => Err(format!("Broker {broker_id} not connected")),
            };
        }

        let entry = entry.ok_or_else(|| format!("Broker {broker_id} not connected"))?;
        let entry_guard = entry.lock().await;
        let broker_guard = entry_guard.broker.read().await;
        broker_guard.unsubscribe(topic, subscriber).await
    }

    /// End every subscription the Connection Console holds, on every broker:
    /// the page that made them is gone, and took the list of them with it.
    /// As for each of them by [`Self::unsubscribe`]: none stands any longer,
    /// and the brokers whose link is up are told.
    pub async fn forget_console(&self) {
        let brokers = self.brokers.read().await;
        let standing = std::mem::take(&mut *self.console());
        for (broker_id, topics) in standing {
            let Some(entry) = brokers.get(&broker_id) else { continue };
            let entry_guard = entry.lock().await;
            let broker_guard = entry_guard.broker.read().await;
            for topic in topics.keys() {
                broker_guard.release(topic, Subscriber::Console).await;
            }
        }
    }

    /// Publish a message to a topic on a broker
    pub async fn publish(
        &self,
        broker_id: &str,
        topic: &str,
        payload: &[u8],
        retain: bool,
    ) -> Result<(), String> {
        let brokers = self.brokers.read().await;

        let entry = brokers
            .get(broker_id)
            .ok_or_else(|| format!("Broker {broker_id} not connected"))?;

        let entry_guard = entry.lock().await;
        let broker_guard = entry_guard.broker.read().await;
        broker_guard.publish(topic, payload, retain).await
    }

    /// Check if a broker is connected
    pub async fn is_connected(&self, broker_id: &str) -> bool {
        matches!(self.status(broker_id).await, ConnectionStatus::Connected)
    }

    /// Get list of connected broker IDs
    pub async fn connected_brokers(&self) -> Vec<String> {
        let brokers = self.brokers.read().await;
        let mut connected = Vec::new();

        for (id, entry) in brokers.iter() {
            let entry_guard = entry.lock().await;
            let broker_guard = entry_guard.broker.read().await;
            if matches!(broker_guard.status().await, ConnectionStatus::Connected) {
                connected.push(id.clone());
            }
        }

        connected
    }
}

impl Default for MqttManager {
    fn default() -> Self {
        Self::new()
    }
}
