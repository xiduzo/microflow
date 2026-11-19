//! The desktop **`CloudPerformer`**: the cloud half of the desktop Runtime Host
//! (ADR-0009), and the one owner of its MQTT subscriptions.
//!
//! The cloud nodes are sans-IO. A turn records what they want sent
//! (`CloudRequest`s) and the flow says what they want to hear (subscriber
//! wirings); this module turns both into calls on the broker pool, behind two
//! entry points:
//!
//! - [`CloudPerformer::perform`] — publish what a turn recorded.
//! - [`CloudPerformer::reconcile`] — make the brokers' subscriptions match the
//!   runtime's subscriber wirings, and announce Studio to the design-tool
//!   plugins whose Bridge ID came or went. It returns a [`Reconciled`] to
//!   wait on until that is done.
//!
//! **Order.** `reconcile` only queues. One task applies the queue, one
//! reconcile at a time, in the order the calls were made; the runtime actor
//! makes them from its own thread, so subscriptions always converge on the
//! flow the runtime is actually running, however many `flow_update`s or
//! respawns overlap. That task alone holds the live subscription set, so there
//! is nothing to lock and no update to lose.
//!
//! **The live set mirrors the brokers.** An entry is recorded only once a
//! broker holds the subscription and dropped only once the broker let go of it,
//! so whatever could not be done — a subscribe or unsubscribe that failed on
//! the wire, a broker that was offline or not connected yet — is simply still
//! different from the desired set, and is done by a later reconcile. Each entry
//! also names the [`BrokerSession`] that holds it: when that session ends (the
//! broker was disconnected, or connected with a new config) the broker has
//! forgotten the subscription and so does this module.
//!
//! **The pool drives the retries.** The task keeps the wirings it was last
//! given and reconciles them again whenever the broker pool says a session
//! started, ended or got its link back ([`MqttBrokers::changes`]) — which is
//! exactly when something pending became possible or something live went
//! stale. Nothing has to send the flow again (the editor does not re-send an
//! unchanged one), and nothing that connects or disconnects a broker has to
//! tell this module. A reconcile that finds nothing to do touches no broker.
//!
//! **Subscribe before announce.** The design-tool handshake
//! (`figma_announce_actions`, core policy shared with the browser — ADR-0011)
//! runs on the live set *after* the (un)subscribes of the same reconcile, so
//! the plugins' answer to Studio's variable request finds its subscription in
//! place. A Bridge ID is announced on one broker, and stays on it while that
//! broker holds one of its topics that the flow still wants: Studio is not
//! said to have left a broker it is still subscribed on. Once the flow wants
//! none there, the Bridge ID leaves that broker and arrives on another one
//! that holds it, if there is one.
//!
//! **Announced is what the broker was told.** A Bridge ID is announced on a
//! broker once the broker took its `connected`, and not before: one whose
//! `connected` did not get through arrives again with a later reconcile — the
//! link coming back is one. Every new link of a broker's session is told
//! again that Studio is there, and asked for the variables: what the broker
//! was told on an earlier link may be gone (a broker that restarted forgets
//! the retained status it did not persist), and what the plugins sent while
//! the link was down never reached Studio.
//!
//! **Nothing is announced on a link that is down.** An arrival waits for the
//! link: the Bridge ID is on no broker until then. A departure does not hold
//! the arrival elsewhere back: the `disconnected` is owed to the old broker
//! and sent when its link is back, unless the Bridge ID returned there first
//! or the broker's session ended. A `disconnected` that did not get through
//! on a link that is up is owed the same way. Two broker ids can name one
//! server, where a `disconnected` that is said late lands on the retained
//! status after the `connected` of a Studio that is still there: so right
//! after an owed `disconnected` went out, `connected` is said once more on
//! the broker the Bridge ID is on now.
//!
//! **A session that is ended on purpose says goodbye first.** When a broker is
//! disconnected, removed from the settings or given other settings, this
//! module hears of it from the pool afterwards, with no link left to publish
//! on. So it leaves the `disconnected` of every Bridge ID it announced on a
//! broker with the pool beforehand ([`MqttBrokers::set_last_words`]), kept up
//! to date as Bridge IDs come and go, and the pool publishes them before it
//! closes the link — as the browser host does when it closes a broker's
//! connection. A link that is down then gets nothing, in either host.
//!
//! The diff itself stays in this host (ADR-0010); which node owns a topic is
//! core's `reconcile_desired`. The broker pool is reached through the
//! [`MqttBrokers`] Capability Trait (ADR-0025) — `MqttManager` in the app, the
//! recording pool in the tests below.

use crate::mqtt::broker::{MessageCallback, MqttMessage as BrokerMessage};
use crate::mqtt::commands::MqttMessage;
use crate::runtime::host::{ActorMsg, HostEvents};
use crate::runtime::services::{BrokerSession, LastWord, MqttBrokers};
use microflow_core::runtime::{
    bridge_uid, figma_announce_actions, reconcile_desired, CloudRequest, CloudRequestKind, DesiredSub, FigmaPublish,
    SubKind, SubscriberWiring,
};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use tokio::runtime::Handle;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::{oneshot, watch};

/// The webview event every inbound broker message is echoed on. The payload is
/// [`MqttMessage`]; for a flow subscription its `broker_id` is empty and its
/// `component_id` names the node the message was routed to (`None` for a
/// display-only subscription).
const MQTT_MESSAGE_EVENT: &str = "mqtt-message";

/// Performs the cloud half of the desktop Runtime Host: see the module docs.
///
/// `Send + Sync`; the runtime actor holds it, to perform each turn's cloud
/// requests and to hand over its subscriber wirings.
pub struct CloudPerformer {
    brokers: Arc<dyn MqttBrokers>,
    rt_handle: Handle,
    /// To the task that owns the live subscription set.
    jobs: UnboundedSender<Job>,
}

/// A reconcile that was handed over: [`Reconciled::applied`] waits for it.
pub struct Reconciled(oneshot::Receiver<()>);

impl Reconciled {
    /// Resolves once the reconcile has been applied to the brokers: every
    /// subscription that could be made is in place, and the design-tool
    /// plugins have been announced to. Not waiting changes nothing.
    pub async fn applied(self) {
        // An error means the performer is gone: there is nothing to wait for.
        let _ = self.0.await;
    }
}

enum Job {
    Reconcile(Vec<(String, SubscriberWiring)>, oneshot::Sender<()>),
    #[cfg(test)]
    Settled(oneshot::Sender<()>),
}

impl CloudPerformer {
    /// A performer over `brokers`. An inbound message for a subscribed node is
    /// sent to the runtime on `actor` (as [`ActorMsg::Deliver`]) and echoed to
    /// the webview through `events`; the subscription task runs on `rt_handle`.
    pub fn new<E>(
        brokers: Arc<dyn MqttBrokers>,
        actor: UnboundedSender<ActorMsg>,
        events: E,
        rt_handle: Handle,
    ) -> Self
    where
        E: HostEvents + Send + Sync + 'static,
    {
        let (jobs, queue) = mpsc::unbounded_channel();
        let subscriptions = Subscriptions {
            brokers: Arc::clone(&brokers),
            inbound: Inbound { actor, echo: Arc::new(move |message| events.emit(MQTT_MESSAGE_EVENT, message)) },
            wirings: Vec::new(),
            live: BTreeMap::new(),
            announced: BTreeMap::new(),
            owed: BTreeMap::new(),
            last_words: BTreeMap::new(),
        };
        // Subscribed here, not in the task: a pool change between this call
        // returning and the task's first poll is not missed.
        let pool = brokers.changes();
        rt_handle.spawn(subscriptions.run(queue, pool));
        Self { brokers, rt_handle, jobs }
    }

    /// Perform one cloud request a turn recorded. Returns at once; the publish
    /// runs on the Tokio runtime and a failure is logged.
    pub fn perform(&self, request: &CloudRequest) {
        match &request.kind {
            CloudRequestKind::MqttPublish { broker_id, topic, payload, retain } => {
                let brokers = Arc::clone(&self.brokers);
                let source = Arc::clone(&request.source);
                let broker_id = broker_id.clone();
                let topic = topic.clone();
                let payload = payload.clone();
                let retain = *retain;
                self.rt_handle.spawn(async move {
                    if let Err(e) = brokers.publish(&broker_id, &topic, &payload, retain).await {
                        log::error!(
                            "[cloud] {source} mqtt publish failed (broker={broker_id} topic={topic}): {e}"
                        );
                    }
                });
            }
            // Intercepted by `Actor::perform_cloud`: MIDI on the actor's own
            // `midir` connections, audio and LLM forwarded to the webview
            // (ADR-0021). A request reaching here has no performer.
            CloudRequestKind::MidiSend { .. }
            | CloudRequestKind::AudioPlay { .. }
            | CloudRequestKind::AudioStop
            | CloudRequestKind::LlmGenerate { .. } => {
                log::warn!(
                    "[cloud] host-peripheral request reached the CloudPerformer — handled by the actor"
                );
            }
        }
    }

    /// The runtime now wires its subscribers as `wirings`: bring the brokers'
    /// subscriptions in line, and keep them in line as brokers come and go.
    /// Returns at once; reconciles are applied one at a time, in the order of
    /// these calls (see the module docs), and the returned [`Reconciled`] says
    /// when this one has been. Call it every time the runtime's wirings may
    /// have changed — an unchanged set (un)subscribes and announces nothing.
    // Called for its effect: waiting on what it returns is the caller's choice.
    #[allow(clippy::must_use_candidate)]
    pub fn reconcile(&self, wirings: Vec<(String, SubscriberWiring)>) -> Reconciled {
        let (applied, reconciled) = oneshot::channel();
        let _ = self.jobs.send(Job::Reconcile(wirings, applied));
        Reconciled(reconciled)
    }
}

/// `(broker_id, topic)`: a broker holds one callback per topic for the flow, so
/// this is a flow subscription's identity.
type Key = (String, String);

/// One subscription a broker holds for the flow.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LiveSubscription {
    /// The node whose wiring owns the flow's callback for this topic. With
    /// `kind`, what decides whether a desired subscription is already in place.
    owner: String,
    kind: SubKind,
    /// The [`BrokerSession::id`] that holds it.
    session: u64,
}

/// Where an inbound broker message goes: to the runtime, and to the webview.
struct Inbound {
    actor: UnboundedSender<ActorMsg>,
    echo: Arc<dyn Fn(MqttMessage) + Send + Sync>,
}

impl Inbound {
    /// The broker callback for a subscription owned by `owner`: routing kinds
    /// deliver to the node and echo to the webview, display-echo only echoes.
    fn callback(&self, owner: &str, kind: SubKind) -> MessageCallback {
        let echo = Arc::clone(&self.echo);
        match kind {
            SubKind::Plain | SubKind::TopicAware => {
                let actor = self.actor.clone();
                let owner = owner.to_string();
                Arc::new(move |message: BrokerMessage| {
                    log::info!("[MQTT] Received message on topic {} for component {owner}", message.topic);
                    let _ = actor.send(ActorMsg::Deliver {
                        id: owner.clone(),
                        topic: message.topic.clone(),
                        payload: message.payload.clone(),
                    });
                    echo(MqttMessage {
                        broker_id: String::new(),
                        topic: message.topic,
                        payload: String::from_utf8_lossy(&message.payload).to_string(),
                        component_id: Some(owner.clone()),
                    });
                })
            }
            SubKind::DisplayEcho => Arc::new(move |message: BrokerMessage| {
                echo(MqttMessage {
                    broker_id: String::new(),
                    topic: message.topic,
                    payload: String::from_utf8_lossy(&message.payload).to_string(),
                    component_id: None,
                });
            }),
        }
    }
}

/// The live subscription set and the task that keeps it. Private: the only way
/// in is [`CloudPerformer::reconcile`].
struct Subscriptions {
    brokers: Arc<dyn MqttBrokers>,
    inbound: Inbound,
    /// The runtime's subscriber wirings as last handed over: what the brokers
    /// should hold, whenever they can.
    wirings: Vec<(String, SubscriberWiring)>,
    /// What the brokers hold for the flow. Ordered, so a reconcile touches the
    /// brokers in the same order every time.
    live: BTreeMap<Key, LiveSubscription>,
    /// The Bridge IDs whose broker was told that Studio is connected for
    /// them, by uid: what the broker was actually told, not what it was meant
    /// to be.
    announced: BTreeMap<String, Said>,
    /// The `disconnected` a broker is owed: a Bridge ID left it while its link
    /// was down. By `(broker_id, status topic)`.
    owed: BTreeMap<Key, OwedGoodbye>,
    /// What each broker was left to say should its session be ended on
    /// purpose, and the [`BrokerSession::id`] it was left with
    /// ([`Self::leave_last_words`]). A broker that was left nothing is not in
    /// it.
    last_words: BTreeMap<String, (u64, Vec<LastWord>)>,
}

/// Where a Bridge ID is announced.
struct Said {
    broker_id: String,
    /// The [`BrokerSession::link`] the whole announcement — `connected` and
    /// the variables request — last got through on; `None` while part of it
    /// is still to be said. A broker whose link is another one by now is told
    /// again: what it was told on an earlier link may be gone, and what the
    /// plugins sent while it was down did not reach Studio.
    link: Option<u64>,
}

/// An announcement a reconcile is about to make.
struct Hello {
    uid: String,
    /// The link it is made on.
    link: u64,
    /// The Bridge ID is announced on this broker already: this says it again.
    again: bool,
    /// `connected`, then the variables request: core's, in its order.
    publishes: Vec<FigmaPublish>,
}

/// A `disconnected` that waits for its broker's link.
struct OwedGoodbye {
    publish: FigmaPublish,
    /// The [`BrokerSession::id`] it belongs to: said in that session or never.
    session: u64,
}

impl Subscriptions {
    /// Reconcile on every job from `queue`, and on every change of `pool`.
    async fn run(mut self, mut queue: UnboundedReceiver<Job>, mut pool: watch::Receiver<u64>) {
        // The pool outlives the performer in the app. Should it go first, only
        // the queue is left to wait on.
        let mut pool_alive = true;
        loop {
            tokio::select! {
                // The pool first: a job handed over after a pool change is
                // answered with that change already applied.
                biased;
                changed = pool.changed(), if pool_alive => match changed {
                    // The wirings are the ones last handed over: only what the
                    // brokers can do about them has changed.
                    Ok(()) => self.reconcile().await,
                    Err(_) => pool_alive = false,
                },
                job = queue.recv() => match job {
                    Some(Job::Reconcile(wirings, applied)) => {
                        self.wirings = wirings;
                        self.reconcile().await;
                        let _ = applied.send(());
                    }
                    #[cfg(test)]
                    Some(Job::Settled(done)) => {
                        let _ = done.send(());
                    }
                    None => return,
                },
            }
        }
    }

    /// Diff the subscriptions the kept wirings want against the live ones and
    /// touch only the delta. With the wirings unchanged and the brokers as they
    /// were, nothing below reaches a broker; adding or removing a node
    /// (un)subscribes just its own topic(s).
    async fn reconcile(&mut self) {
        // One desired subscription per (broker, topic); which node wins a
        // shared topic is core policy, the same in the browser host.
        let desired: BTreeMap<Key, DesiredSub> = reconcile_desired(&self.wirings)
            .into_iter()
            .map(|sub| ((sub.broker_id.clone(), sub.topic.clone()), sub))
            .collect();

        // Each broker's session, read once: what this reconcile decides on.
        let mut sessions: HashMap<String, Option<BrokerSession>> = HashMap::new();
        let keyed = self.live.keys().chain(desired.keys()).chain(self.owed.keys()).map(|(broker_id, _)| broker_id);
        for broker_id in keyed.chain(self.last_words.keys()) {
            if !sessions.contains_key(broker_id) {
                sessions.insert(broker_id.clone(), self.brokers.session(broker_id).await);
            }
        }
        let session = |broker_id: &str| sessions.get(broker_id).copied().flatten();
        let online = |broker_id: &str| session(broker_id).filter(|session| session.online);

        // A subscription whose session ended is gone from its broker.
        self.live.retain(|(broker_id, _), sub| session(broker_id).is_some_and(|now| now.id == sub.session));
        // So is what the session was told, and what it was still to be told. A
        // Bridge ID none of whose topics its broker holds any more is
        // announced nowhere now, and a `disconnected` owed to a session that
        // ended cannot be said.
        let live = &self.live;
        self.announced.retain(|uid, said| {
            live.keys().any(|(held_on, topic)| *held_on == said.broker_id && bridge_uid(topic) == Some(uid.as_str()))
        });
        self.owed.retain(|(broker_id, _), goodbye| session(broker_id).is_some_and(|now| now.id == goodbye.session));

        // Topics the flow no longer wants: unsubscribe. One the broker cannot
        // let go of now — its link is down, or it refused — stays in the live
        // set, as it stays on the broker, and the next reconcile tries again.
        let unwanted: Vec<Key> = self.live.keys().filter(|key| !desired.contains_key(*key)).cloned().collect();
        for key in unwanted {
            let (broker_id, topic) = &key;
            if online(broker_id).is_none() {
                continue;
            }
            log::info!("[MQTT] Unsubscribing topic {topic} on broker {broker_id}");
            match self.brokers.unsubscribe(broker_id, topic).await {
                Ok(()) => {
                    self.live.remove(&key);
                }
                Err(e) => log::warn!("[MQTT] Failed to unsubscribe {topic} on broker {broker_id}, will retry: {e}"),
            }
        }

        // New topics, and topics whose owner or kind changed: (re)subscribe.
        // A subscription already in place keeps its broker callback untouched;
        // one that cannot be replaced now keeps its old owner on the broker and
        // in the live set.
        for (key, want) in &desired {
            let in_place = self.live.get(key).is_some_and(|held| held.owner == want.node_id && held.kind == want.kind);
            if in_place {
                continue;
            }
            let (broker_id, topic) = key;
            if online(broker_id).is_none() {
                log::warn!("[MQTT] Broker {broker_id} not connected, skipping subscription for {}", want.node_id);
                continue;
            }
            let callback = self.inbound.callback(&want.node_id, want.kind);
            match self.brokers.subscribe(broker_id, topic, callback).await {
                Ok(session) => {
                    let sub = LiveSubscription { owner: want.node_id.clone(), kind: want.kind, session };
                    self.live.insert(key.clone(), sub);
                }
                // Not recorded: the broker holds nothing new, so the next
                // reconcile finds the topic still missing and subscribes again.
                Err(e) => log::error!(
                    "[MQTT] Failed to subscribe component {} to {topic}, will retry: {e}",
                    want.node_id
                ),
            }
        }

        // The design-tool handshake: a Bridge ID that left a broker announces
        // `disconnected` there, one that arrived on a broker announces
        // `connected` there and requests its variables. Topics, payloads,
        // retain flags and order are core's (`figma_announce_actions`); here
        // they are only published, and only to a broker that is online. It
        // follows the live set as it stands after the subscribes above: a
        // Bridge ID is announced once a subscription is in place to catch the
        // answer to the request, and leaves a broker once the flow wants none
        // of its topics there.
        let was = self.announced_brokers();
        let next = bridge_uids(&self.live, &desired, &was, |broker_id| online(broker_id).is_some());

        // Departures: what to say now, with the session it is owed to should
        // it not get through. A Bridge ID that leaves is announced there no
        // longer, said or owed.
        let mut goodbyes: Vec<(FigmaPublish, u64)> = Vec::new();
        for (uid, broker_id) in &was {
            if next.get(uid) == Some(broker_id) {
                continue;
            }
            self.announced.remove(uid);
            for action in departure(uid, broker_id) {
                // Whatever the broker was owed on this topic is out of date.
                let key = (action.broker_id.clone(), action.topic.clone());
                self.owed.remove(&key);
                match session(&action.broker_id) {
                    Some(now) if now.online => goodbyes.push((action, now.id)),
                    // Owed until the link is back.
                    Some(now) => {
                        self.owed.insert(key, OwedGoodbye { publish: action, session: now.id });
                    }
                    // The broker is gone: there is nobody to tell.
                    None => {}
                }
            }
        }

        // Arrivals, and Bridge IDs to announce again where they are: the
        // link they were last announced on is not the one up now, or not all
        // of the announcement got through on it. Only on a link that is up.
        let mut hellos: Vec<Hello> = Vec::new();
        for (uid, broker_id) in &next {
            let Some(now) = online(broker_id) else { continue };
            let said = self.announced.get(uid).filter(|said| said.broker_id == *broker_id);
            if said.is_some_and(|said| said.link == Some(now.link)) {
                continue;
            }
            let publishes = arrival(uid, broker_id);
            // A goodbye owed here is out of date: the Bridge ID came back
            // before it was said to be gone.
            for publish in &publishes {
                self.owed.remove(&(publish.broker_id.clone(), publish.topic.clone()));
            }
            hellos.push(Hello { uid: uid.clone(), link: now.link, again: said.is_some(), publishes });
        }

        // Before anything is announced: a session that is ended on purpose
        // from here on says goodbye for what it is about to be told — and
        // still for what it is about to be told has left: a goodbye, and the
        // will it is, are taken back only once it was said (below).
        let leaving_or_there: BTreeSet<(String, String)> =
            was.iter().chain(&next).map(|(uid, broker_id)| (uid.clone(), broker_id.clone())).collect();
        self.leave_last_words(&sessions, &leaving_or_there).await;

        // First what is owed to a broker whose link is back, then this
        // reconcile's own announcements in core's order: departures before
        // arrivals. A goodbye that does not get through stays owed.
        let due: Vec<Key> = self.owed.keys().filter(|(broker_id, _)| online(broker_id).is_some()).cloned().collect();
        for key in due {
            let Some(goodbye) = self.owed.get(&key) else { continue };
            if !self.publish(&goodbye.publish).await {
                continue;
            }
            self.owed.remove(&key);
            // The goodbye was owed since before the Bridge ID arrived where
            // it is now. Two broker ids can name one server, and there it has
            // just replaced the retained `connected` of a Studio that is
            // still there: say `connected` once more — unless this reconcile
            // is about to.
            let (_, status_topic) = &key;
            if let Some(connected) = self.standing_announcement(status_topic) {
                let about_to = hellos.iter().flat_map(|hello| &hello.publishes).any(|publish| *publish == connected);
                if !about_to && online(&connected.broker_id).is_some() {
                    self.publish(&connected).await;
                }
            }
        }
        for (action, session) in goodbyes {
            if self.publish(&action).await {
                continue;
            }
            // A goodbye that did not get through on a link that is up — the
            // link dropped under it — is owed like one that could not be sent.
            let key = (action.broker_id.clone(), action.topic.clone());
            self.owed.insert(key, OwedGoodbye { publish: action, session });
        }
        for hello in hellos {
            self.say(hello).await;
        }

        // And after: what was said, and what was owed and has been said, is
        // what is taken back.
        let announced: BTreeSet<(String, String)> = self.announced_brokers().into_iter().collect();
        self.leave_last_words(&sessions, &announced).await;
    }

    /// `uid -> broker_id` of every Bridge ID announced.
    fn announced_brokers(&self) -> BTreeMap<String, String> {
        self.announced.iter().map(|(uid, said)| (uid.clone(), said.broker_id.clone())).collect()
    }

    /// Announce a Bridge ID on its broker. It is announced there once the
    /// broker took its `connected`, and the announcement is through once it
    /// took the whole of it; until then it is said again by a later
    /// reconcile — which the link coming back is. One that was announced
    /// there already stays so whatever gets through: the broker still holds
    /// the `connected` it was told before.
    async fn say(&mut self, hello: Hello) {
        let mut told = 0;
        for publish in &hello.publishes {
            if !self.publish(publish).await {
                break;
            }
            told += 1;
        }
        let Some(first) = hello.publishes.first() else { return };
        if told == 0 && !hello.again {
            return;
        }
        let link = (told == hello.publishes.len()).then_some(hello.link);
        self.announced.insert(hello.uid, Said { broker_id: first.broker_id.clone(), link });
    }

    /// Leave with each broker what it is to publish should its session be
    /// ended on purpose ([`MqttBrokers::set_last_words`]): the `disconnected`
    /// of every Bridge ID `announced` on it (`(uid, broker_id)`), and the
    /// `disconnected` it is still owed. A broker that is removed, or given
    /// other settings, is then not left with a retained `connected` for a
    /// Studio that is gone — this module hears of the session's end only
    /// after it. A broker is told only when its list changed.
    ///
    /// The goodbyes are core's (`figma_announce_actions`, for a Bridge ID that
    /// leaves its broker); the pool carries them without knowing what they
    /// are.
    async fn leave_last_words(
        &mut self,
        sessions: &HashMap<String, Option<BrokerSession>>,
        announced: &BTreeSet<(String, String)>,
    ) {
        let mut wanted: BTreeMap<String, Vec<LastWord>> = BTreeMap::new();
        for (uid, broker_id) in announced {
            wanted.entry(broker_id.clone()).or_default().extend(departure(uid, broker_id).iter().map(last_word));
        }
        for ((broker_id, _), goodbye) in &self.owed {
            wanted.entry(broker_id.clone()).or_default().push(last_word(&goodbye.publish));
        }
        // A broker that was left something and has nothing to say any more.
        for broker_id in self.last_words.keys() {
            wanted.entry(broker_id.clone()).or_default();
        }

        for (broker_id, words) in wanted {
            let Some(session) = sessions.get(&broker_id).copied().flatten() else {
                // The session ended, and what was left with it went with it.
                self.last_words.remove(&broker_id);
                continue;
            };
            let left = self.last_words.get(&broker_id);
            let unchanged = match left {
                Some((with, left)) => *with == session.id && *left == words,
                // A session starts with nothing to say.
                None => words.is_empty(),
            };
            if unchanged {
                continue;
            }
            self.brokers.set_last_words(&broker_id, session.id, words.clone()).await;
            if words.is_empty() {
                self.last_words.remove(&broker_id);
            } else {
                self.last_words.insert(broker_id, (session.id, words));
            }
        }
    }

    /// The retained `connected` of the Bridge ID whose status topic is
    /// `status_topic`, on the broker Studio is announced for it on; `None`
    /// when it is announced nowhere. The publish is core's
    /// (`figma_announce_actions`, for a Bridge ID that arrives).
    fn standing_announcement(&self, status_topic: &str) -> Option<FigmaPublish> {
        self.announced.iter().find_map(|(uid, said)| {
            arrival(uid, &said.broker_id).into_iter().find(|publish| publish.topic == status_topic)
        })
    }

    /// Publish one design-bridge announcement; `false` when it did not get
    /// onto the wire.
    async fn publish(&self, action: &FigmaPublish) -> bool {
        let published =
            self.brokers.publish(&action.broker_id, &action.topic, action.payload.as_bytes(), action.retain).await;
        if let Err(e) = &published {
            log::error!("[MQTT] design-bridge publish to {} failed: {e}", action.topic);
        }
        published.is_ok()
    }
}

/// What a broker is told when Bridge ID `uid` leaves it: core's
/// `figma_announce_actions`, for that one Bridge ID.
fn departure(uid: &str, broker_id: &str) -> Vec<FigmaPublish> {
    figma_announce_actions(&BTreeMap::from([(uid.to_string(), broker_id.to_string())]), &BTreeMap::new())
}

/// What a broker is told when Bridge ID `uid` arrives on it, in order: core's
/// `figma_announce_actions`, for that one Bridge ID.
fn arrival(uid: &str, broker_id: &str) -> Vec<FigmaPublish> {
    figma_announce_actions(&BTreeMap::new(), &BTreeMap::from([(uid.to_string(), broker_id.to_string())]))
}

/// A design-bridge announcement, as a message for the pool to carry.
fn last_word(publish: &FigmaPublish) -> LastWord {
    LastWord { topic: publish.topic.clone(), payload: publish.payload.clone().into_bytes(), retain: publish.retain }
}

/// `uid -> broker_id`: the broker each Bridge ID is on — the input core's
/// `figma_announce_actions` takes.
///
/// A broker has a Bridge ID while it holds a design-bridge topic of it
/// ([`bridge_uid`]) that the flow still wants: a topic the broker could not let
/// go of yet (`live`, no longer `desired`) does not keep Studio there. A uid
/// that is on several brokers keeps its `announced` broker while it is there;
/// otherwise the first broker in the live set's order that is `online` has
/// it. Nothing can be said on a link that is down, so a Bridge ID arrives on
/// such a broker when its link is back.
///
/// Extracting the uids is parsing of this host's own set and stays here
/// (ADR-0010; the browser's `uidBrokers` keeps a uid on its announced broker
/// the same way); the `BTreeMap` gives core the deterministic order it expects.
fn bridge_uids(
    live: &BTreeMap<Key, LiveSubscription>,
    desired: &BTreeMap<Key, DesiredSub>,
    announced: &BTreeMap<String, String>,
    online: impl Fn(&str) -> bool,
) -> BTreeMap<String, String> {
    let mut uids: BTreeMap<String, String> = BTreeMap::new();
    for key in live.keys().filter(|key| desired.contains_key(*key)) {
        let (broker_id, topic) = key;
        let Some(uid) = bridge_uid(topic) else { continue };
        let stays = announced.get(uid) == Some(broker_id);
        if stays || (!uids.contains_key(uid) && online(broker_id)) {
            uids.insert(uid.to_string(), broker_id.clone());
        }
    }
    uids
}

#[cfg(test)]
impl CloudPerformer {
    /// Resolves once the subscription task has caught up: every reconcile
    /// handed over before this call is applied, and so is every pool change
    /// made before it. What a test waits on after changing the pool — in the
    /// app nothing waits for a pool change.
    pub(crate) async fn settled(&self) {
        let (done, caught_up) = oneshot::channel();
        let _ = self.jobs.send(Job::Settled(done));
        let _ = caught_up.await;
    }

    /// A performer over a recording pool with broker `b` connected, echoing
    /// inbound messages nowhere: what the actor's tests give the actor. The
    /// pool is returned so a test can look at what the performer did with it.
    pub(crate) fn on_recording_pool(
        actor: UnboundedSender<ActorMsg>,
        rt_handle: Handle,
    ) -> (Arc<Self>, Arc<crate::runtime::services::RecordingMqttBrokers>) {
        struct NoEvents;
        impl HostEvents for NoEvents {
            fn emit<S: serde::Serialize + Clone>(&self, _event: &str, _payload: S) {}
        }
        let brokers = Arc::new(crate::runtime::services::RecordingMqttBrokers::new());
        brokers.connect("b");
        let performer = Self::new(Arc::clone(&brokers) as Arc<dyn MqttBrokers>, actor, NoEvents, rt_handle);
        (Arc::new(performer), brokers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::services::{BrokerCall, BrokerOp, MqttError, RecordedPublish, RecordingMqttBrokers};
    use std::sync::Mutex;
    use std::time::Duration;

    /// The webview events the performer emitted, as JSON.
    #[derive(Clone, Default)]
    struct RecordedEvents(Arc<Mutex<Vec<(String, serde_json::Value)>>>);

    impl HostEvents for RecordedEvents {
        fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) {
            self.0.lock().unwrap().push((event.to_string(), serde_json::to_value(payload).unwrap()));
        }
    }

    /// A performer over a recording pool with broker `b` connected.
    struct Rig {
        performer: CloudPerformer,
        brokers: Arc<RecordingMqttBrokers>,
        /// What the performer sent to the runtime actor.
        actor: UnboundedReceiver<ActorMsg>,
        events: RecordedEvents,
    }

    impl Rig {
        fn new() -> Self {
            let brokers = Arc::new(RecordingMqttBrokers::new());
            brokers.connect("b");
            let (actor_tx, actor) = mpsc::unbounded_channel();
            let events = RecordedEvents::default();
            let performer = CloudPerformer::new(
                Arc::clone(&brokers) as Arc<dyn MqttBrokers>,
                actor_tx,
                events.clone(),
                Handle::current(),
            );
            Self { performer, brokers, actor, events }
        }

        /// A flow update: hand over `wirings` and wait until they are applied.
        async fn reconcile(&self, wirings: &[(String, SubscriberWiring)]) {
            self.performer.reconcile(wirings.to_vec()).applied().await;
        }

        /// The broker pool changed: wait until the performer has caught up.
        /// No flow update is involved.
        async fn settled(&self) {
            self.performer.settled().await;
        }

        /// The calls the pool received since the last `take_calls`.
        fn take_calls(&self, seen: &mut usize) -> Vec<BrokerCall> {
            let calls = self.brokers.calls();
            let new = calls[*seen..].to_vec();
            *seen = calls.len();
            new
        }

        fn events(&self) -> Vec<(String, serde_json::Value)> {
            self.events.0.lock().unwrap().clone()
        }
    }

    fn plain(node: &str, topic: &str) -> (String, SubscriberWiring) {
        (node.to_string(), SubscriberWiring::Plain { broker_id: "b".into(), topic: topic.into() })
    }

    fn echo(node: &str, topic: &str) -> (String, SubscriberWiring) {
        (node.to_string(), SubscriberWiring::DisplayEcho { broker_id: "b".into(), topic: topic.into() })
    }

    /// A design variable node's wiring: a design-bridge topic for Bridge ID `uid`.
    fn bridge(node: &str, uid: &str) -> (String, SubscriberWiring) {
        bridge_on("b", node, uid)
    }

    /// [`bridge`], for a node whose broker is `broker_id`.
    fn bridge_on(broker_id: &str, node: &str, uid: &str) -> (String, SubscriberWiring) {
        let topic = format!("microflow/{uid}/figma/variable/1-2");
        (node.to_string(), SubscriberWiring::TopicAware { broker_id: broker_id.into(), topic })
    }

    /// `call`, made on `broker_id` instead of `b`.
    fn on(broker_id: &str, call: BrokerCall) -> BrokerCall {
        let broker_id = broker_id.to_string();
        match call {
            BrokerCall::Subscribe { topic, .. } => BrokerCall::Subscribe { broker_id, topic },
            BrokerCall::Unsubscribe { topic, .. } => BrokerCall::Unsubscribe { broker_id, topic },
            BrokerCall::Publish(publish) => BrokerCall::Publish(RecordedPublish { broker_id, ..publish }),
        }
    }

    fn subscribe(topic: &str) -> BrokerCall {
        BrokerCall::Subscribe { broker_id: "b".into(), topic: topic.into() }
    }

    fn unsubscribe(topic: &str) -> BrokerCall {
        BrokerCall::Unsubscribe { broker_id: "b".into(), topic: topic.into() }
    }

    fn publish(topic: &str, payload: &str, retain: bool) -> BrokerCall {
        BrokerCall::Publish(RecordedPublish {
            broker_id: "b".into(),
            topic: topic.into(),
            payload: payload.as_bytes().to_vec(),
            retain,
        })
    }

    fn topics(topics: &[&str]) -> Vec<String> {
        topics.iter().map(ToString::to_string).collect()
    }

    // --- perform -------------------------------------------------------------

    fn request(source: &str, kind: CloudRequestKind) -> CloudRequest {
        CloudRequest { source: Arc::from(source), kind }
    }

    async fn wait_for_publishes(brokers: &RecordingMqttBrokers, min: usize) -> Vec<RecordedPublish> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        loop {
            let published = brokers.published();
            if published.len() >= min || tokio::time::Instant::now() >= deadline {
                return published;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn an_mqtt_publish_request_reaches_the_broker() {
        let rig = Rig::new();
        rig.performer.perform(&request(
            "m",
            CloudRequestKind::MqttPublish {
                broker_id: "b".into(),
                topic: "sensors/light".into(),
                payload: b"42".to_vec(),
                retain: true,
            },
        ));

        let sent = wait_for_publishes(&rig.brokers, 1).await;
        assert_eq!(
            sent,
            vec![RecordedPublish {
                broker_id: "b".into(),
                topic: "sensors/light".into(),
                payload: b"42".to_vec(),
                retain: true,
            }]
        );
    }

    #[tokio::test]
    async fn a_request_the_actor_performs_itself_reaches_no_broker() {
        // LLM (ADR-0021), audio and MIDI are intercepted by `Actor::perform_cloud`.
        // One that reaches the performer anyway must do nothing rather than
        // fall through to a publish.
        let rig = Rig::new();
        rig.performer.perform(&request(
            "llm",
            CloudRequestKind::LlmGenerate {
                provider_id: "p".into(),
                model: "m".into(),
                system: None,
                prompt: "hi".into(),
            },
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(rig.brokers.calls().is_empty(), "{:?}", rig.brokers.calls());
    }

    // --- reconcile: the diff -------------------------------------------------

    #[tokio::test]
    async fn a_new_wiring_subscribes_and_a_removed_one_unsubscribes() {
        let rig = Rig::new();
        let mut seen = 0;

        rig.reconcile(&[plain("n1", "t1"), plain("n2", "t2")]).await;
        assert_eq!(rig.take_calls(&mut seen), vec![subscribe("t1"), subscribe("t2")]);

        rig.reconcile(&[plain("n2", "t2"), plain("n3", "t3")]).await;
        assert_eq!(rig.take_calls(&mut seen), vec![unsubscribe("t1"), subscribe("t3")]);
        assert_eq!(rig.brokers.subscriptions("b"), topics(&["t2", "t3"]));
    }

    #[tokio::test]
    async fn an_unchanged_wiring_touches_no_broker() {
        // A flow update that leaves the subscribe nodes alone — an edit
        // elsewhere in the flow, a respawn of the same flow — hands over the
        // same wirings, in whatever order the runtime collected them.
        let rig = Rig::new();
        let wirings = [plain("n1", "t1"), bridge("fig", "uid_1")];
        rig.reconcile(&wirings).await;
        let mut seen = rig.brokers.calls().len();

        rig.reconcile(&wirings).await;
        rig.reconcile(&[wirings[1].clone(), wirings[0].clone()]).await;

        assert_eq!(rig.take_calls(&mut seen), vec![], "no subscribe, no unsubscribe, no announce");
    }

    #[tokio::test]
    async fn two_nodes_on_one_topic_make_one_subscription() {
        // Core picks the owner (the lower node id); the broker is asked once.
        let mut rig = Rig::new();
        rig.reconcile(&[plain("n2", "t"), plain("n1", "t")]).await;

        assert_eq!(rig.brokers.calls(), vec![subscribe("t")]);
        assert!(rig.brokers.deliver("b", "t", b"x"));
        let ActorMsg::Deliver { id, .. } = rig.actor.try_recv().expect("delivered") else { panic!("not a Deliver") };
        assert_eq!(id, "n1");
        assert!(rig.actor.try_recv().is_err(), "one delivery");
    }

    #[tokio::test]
    async fn a_topic_whose_owner_changed_is_subscribed_again() {
        let mut rig = Rig::new();
        rig.reconcile(&[plain("n1", "t")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.reconcile(&[plain("n2", "t")]).await;

        assert_eq!(rig.take_calls(&mut seen), vec![subscribe("t")], "the broker's one callback is replaced");
        assert!(rig.brokers.deliver("b", "t", b"x"));
        let ActorMsg::Deliver { id, .. } = rig.actor.try_recv().expect("delivered") else { panic!("not a Deliver") };
        assert_eq!(id, "n2", "messages now reach the new owner");
    }

    #[tokio::test]
    async fn a_topic_whose_kind_changed_is_subscribed_again() {
        let mut rig = Rig::new();
        rig.reconcile(&[plain("n1", "t")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.reconcile(&[echo("n1", "t")]).await;

        assert_eq!(rig.take_calls(&mut seen), vec![subscribe("t")]);
        assert!(rig.brokers.deliver("b", "t", b"x"));
        assert!(rig.actor.try_recv().is_err(), "a display-only subscription routes to no node");
    }

    // --- reconcile: inbound messages ------------------------------------------

    #[tokio::test]
    async fn a_message_for_a_node_is_delivered_to_the_runtime_and_echoed_to_the_webview() {
        let mut rig = Rig::new();
        rig.reconcile(&[plain("n1", "sensors/light")]).await;

        assert!(rig.brokers.deliver("b", "sensors/light", b"42"));

        let ActorMsg::Deliver { id, topic, payload } = rig.actor.try_recv().expect("delivered") else {
            panic!("not a Deliver")
        };
        assert_eq!((id.as_str(), topic.as_str(), payload.as_slice()), ("n1", "sensors/light", b"42".as_slice()));
        // The `mqtt-message` contract the webview reads: snake_case fields, an
        // empty `broker_id`, the node in `component_id`.
        assert_eq!(
            rig.events(),
            vec![(
                "mqtt-message".to_string(),
                serde_json::json!({
                    "broker_id": "",
                    "topic": "sensors/light",
                    "payload": "42",
                    "component_id": "n1",
                }),
            )]
        );
    }

    #[tokio::test]
    async fn a_display_only_message_is_echoed_without_a_node() {
        let mut rig = Rig::new();
        rig.reconcile(&[echo("n1", "t")]).await;

        assert!(rig.brokers.deliver("b", "t", b"hello"));

        assert!(rig.actor.try_recv().is_err(), "nothing is routed to the runtime");
        assert_eq!(
            rig.events(),
            vec![(
                "mqtt-message".to_string(),
                serde_json::json!({ "broker_id": "", "topic": "t", "payload": "hello", "component_id": null }),
            )]
        );
    }

    // --- reconcile: the design-tool handshake ----------------------------------

    #[tokio::test]
    async fn a_new_bridge_id_is_subscribed_before_it_is_announced() {
        let rig = Rig::new();
        rig.reconcile(&[bridge("fig", "uid_1")]).await;

        assert_eq!(
            rig.brokers.calls(),
            vec![
                subscribe("microflow/uid_1/figma/variable/1-2"),
                publish("microflow/uid_1/app/status", "connected", true),
                publish("microflow/uid_1/app/variables/request", "", false),
            ],
            "the answer to the request needs the subscription in place"
        );
    }

    #[tokio::test]
    async fn a_vanished_bridge_id_announces_disconnected() {
        let rig = Rig::new();
        rig.reconcile(&[bridge("fig", "uid_1"), plain("n1", "t")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.reconcile(&[plain("n1", "t")]).await;

        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                unsubscribe("microflow/uid_1/figma/variable/1-2"),
                publish("microflow/uid_1/app/status", "disconnected", true),
            ]
        );
    }

    #[tokio::test]
    async fn a_plain_topic_under_the_bridge_root_announces_nothing() {
        // A generic Mqtt node may subscribe `microflow/…`; only design-bridge
        // topics carry a Bridge ID.
        let rig = Rig::new();
        rig.reconcile(&[plain("n1", "microflow/uid_1/custom")]).await;
        assert_eq!(rig.brokers.calls(), vec![subscribe("microflow/uid_1/custom")]);
    }

    #[tokio::test]
    async fn a_bridge_id_whose_node_moves_to_another_broker_leaves_the_old_one_and_arrives_on_the_new_one() {
        let rig = Rig::new();
        rig.brokers.connect("b2");
        rig.reconcile(&[bridge_on("b2", "fig", "uid_1")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;

        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                on("b2", unsubscribe("microflow/uid_1/figma/variable/1-2")),
                subscribe("microflow/uid_1/figma/variable/1-2"),
                on("b2", publish("microflow/uid_1/app/status", "disconnected", true)),
                publish("microflow/uid_1/app/status", "connected", true),
                publish("microflow/uid_1/app/variables/request", "", false),
            ],
            "the old broker must not keep a retained `connected`, and the new one must be told"
        );
    }

    #[tokio::test]
    async fn a_bridge_id_on_two_brokers_is_announced_on_the_one_that_held_it_first_and_leaves_from_there() {
        let rig = Rig::new();
        rig.brokers.connect("b2");
        let on_second = bridge_on("b2", "pen", "uid_1");
        rig.reconcile(std::slice::from_ref(&on_second)).await;
        let mut seen = rig.brokers.calls().len();

        // A second node brings the Bridge ID to broker `b` as well. Studio is
        // still on `b2`, where it was announced: nothing is said.
        rig.reconcile(&[on_second, bridge_on("b", "fig", "uid_1")]).await;
        assert_eq!(rig.take_calls(&mut seen), vec![subscribe("microflow/uid_1/figma/variable/1-2")]);

        // The node on `b2` goes: the Bridge ID leaves `b2` and is now on `b`.
        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                on("b2", unsubscribe("microflow/uid_1/figma/variable/1-2")),
                on("b2", publish("microflow/uid_1/app/status", "disconnected", true)),
                publish("microflow/uid_1/app/status", "connected", true),
                publish("microflow/uid_1/app/variables/request", "", false),
            ]
        );

        rig.reconcile(&[]).await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                unsubscribe("microflow/uid_1/figma/variable/1-2"),
                publish("microflow/uid_1/app/status", "disconnected", true),
            ]
        );
    }

    #[tokio::test]
    async fn a_bridge_id_whose_announced_broker_starts_a_new_session_is_announced_where_it_is_still_held() {
        // `b2` is connected with a new config: its session ended without a
        // goodbye, and nothing of the Bridge ID is held there for a moment. It
        // is announced on `b`, which holds it, and stays there.
        let rig = Rig::new();
        rig.brokers.connect("b2");
        let wirings = [bridge_on("b2", "pen", "uid_1"), bridge_on("b", "fig", "uid_1")];
        rig.reconcile(&wirings[..1]).await;
        rig.reconcile(&wirings).await;
        let mut seen = rig.brokers.calls().len();

        rig.brokers.connect("b2");
        rig.settled().await;

        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                on("b2", subscribe("microflow/uid_1/figma/variable/1-2")),
                publish("microflow/uid_1/app/status", "connected", true),
                publish("microflow/uid_1/app/variables/request", "", false),
            ]
        );
    }

    // --- the pool changed: no flow update, the performer catches up ----------------
    //
    // The editor sends a flow when it changed. Whatever a reconcile could not
    // do is therefore done when the *pool* changes — every test below changes
    // the pool and hands over no wirings.

    #[tokio::test]
    async fn a_subscription_skipped_while_its_broker_was_offline_is_made_when_the_link_is_back() {
        let rig = Rig::new();
        rig.brokers.set_online("b", false);
        rig.reconcile(&[bridge("fig", "uid_1")]).await;
        assert_eq!(rig.brokers.calls(), vec![], "an offline broker is left alone");

        rig.brokers.set_online("b", true);
        rig.settled().await;

        assert_eq!(
            rig.brokers.calls(),
            vec![
                subscribe("microflow/uid_1/figma/variable/1-2"),
                publish("microflow/uid_1/app/status", "connected", true),
                publish("microflow/uid_1/app/variables/request", "", false),
            ]
        );
    }

    #[tokio::test]
    async fn a_broker_connected_after_the_flow_was_applied_gets_the_flows_subscriptions() {
        // The flow names a broker the pool does not hold yet.
        let rig = Rig::new();
        rig.brokers.disconnect("b");
        rig.reconcile(&[plain("n1", "t")]).await;
        assert_eq!(rig.brokers.calls(), vec![]);

        rig.brokers.connect("b");
        rig.settled().await;

        assert_eq!(rig.brokers.calls(), vec![subscribe("t")]);
    }

    #[tokio::test]
    async fn a_broker_connected_with_a_new_config_gets_its_subscriptions_again() {
        // A config change ends the broker's session and starts a new one,
        // which holds nothing. Whoever did that — `flow_update`, the broker
        // settings sync — the flow's subscriptions are made again on the new
        // connection and Studio is announced on it.
        let rig = Rig::new();
        rig.reconcile(&[plain("n1", "t"), bridge("fig", "uid_1")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.brokers.connect("b");
        rig.settled().await;

        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                subscribe("microflow/uid_1/figma/variable/1-2"),
                subscribe("t"),
                publish("microflow/uid_1/app/status", "connected", true),
                publish("microflow/uid_1/app/variables/request", "", false),
            ]
        );
    }

    #[tokio::test]
    async fn a_link_that_bounces_subscribes_nothing_and_says_again_that_studio_is_there() {
        // The broker kept its subscriptions and subscribed them again itself.
        // What it was told on the link before may be gone — a broker that
        // restarted forgets the retained status it did not persist — and what
        // the plugins sent meanwhile did not reach Studio: on each new link,
        // Studio is announced again and asks for the values.
        let rig = Rig::new();
        rig.reconcile(&[plain("n1", "t"), bridge("fig", "uid_1")]).await;
        let mut seen = rig.brokers.calls().len();

        for _ in 0..2 {
            rig.brokers.set_online("b", false);
            rig.brokers.set_online("b", true);
            rig.settled().await;
            assert_eq!(rig.take_calls(&mut seen), announced("uid_1"), "no subscribe; announced again");
        }

        // A pool change that is not this broker's link coming back says nothing.
        rig.brokers.connect("b2");
        rig.settled().await;
        assert_eq!(rig.take_calls(&mut seen), vec![]);
    }

    /// What broker `b` is told when Studio is announced there for `uid`.
    fn announced(uid: &str) -> Vec<BrokerCall> {
        vec![
            publish(&format!("microflow/{uid}/app/status"), "connected", true),
            publish(&format!("microflow/{uid}/app/variables/request"), "", false),
        ]
    }

    #[tokio::test]
    async fn a_connected_that_did_not_get_through_is_said_when_the_link_is_back() {
        // The link drops under the `connected` of a Bridge ID that arrives.
        let rig = Rig::new();
        let mut seen = 0;
        rig.brokers.script_err(BrokerOp::Publish, MqttError::Failed("connection reset".into()));

        rig.reconcile(&[bridge("fig", "uid_1")]).await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![subscribe("microflow/uid_1/figma/variable/1-2"), publish("microflow/uid_1/app/status", "connected", true)],
            "no request goes out after a status that did not"
        );
        assert_eq!(rig.brokers.last_words("b"), vec![], "the broker was told nothing: there is nothing to take back");

        bounce(&rig, "b").await;
        assert_eq!(rig.take_calls(&mut seen), announced("uid_1"), "said when the link is back");
        assert_eq!(rig.brokers.last_words("b"), vec![goodbye("uid_1")]);
    }

    #[tokio::test]
    async fn a_connected_that_did_not_get_through_is_said_with_the_next_flow_update() {
        let rig = Rig::new();
        rig.brokers.script_err(BrokerOp::Publish, MqttError::Failed("connection reset".into()));
        rig.reconcile(&[bridge("fig", "uid_1")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.reconcile(&[bridge("fig", "uid_1")]).await;

        assert_eq!(rig.take_calls(&mut seen), announced("uid_1"));
    }

    #[tokio::test]
    async fn an_announcement_that_did_not_get_through_again_is_said_on_the_next_link_and_still_taken_back() {
        // Announced, then said again on a new link, where the link drops
        // under it: the broker holds the `connected` it was told before, so
        // Studio is still announced there — said again on the next link, and
        // taken back should the broker go.
        let rig = Rig::new();
        rig.reconcile(&[bridge("fig", "uid_1")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.brokers.script_err(BrokerOp::Publish, MqttError::Failed("connection reset".into()));
        bounce(&rig, "b").await;
        assert_eq!(rig.take_calls(&mut seen), announced("uid_1")[..1]);
        assert_eq!(rig.brokers.last_words("b"), vec![goodbye("uid_1")], "still announced");

        bounce(&rig, "b").await;
        assert_eq!(rig.take_calls(&mut seen), announced("uid_1"));
        rig.reconcile(&[]).await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![unsubscribe("microflow/uid_1/figma/variable/1-2"), publish("microflow/uid_1/app/status", "disconnected", true)]
        );
    }

    #[tokio::test]
    async fn a_disconnected_broker_is_forgotten_without_being_called() {
        let rig = Rig::new();
        rig.reconcile(&[plain("n1", "t")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.brokers.disconnect("b");
        rig.settled().await;
        assert_eq!(rig.take_calls(&mut seen), vec![], "there is nothing left to unsubscribe");

        // Connected again, the topic is subscribed as new.
        rig.brokers.connect("b");
        rig.settled().await;
        assert_eq!(rig.take_calls(&mut seen), vec![subscribe("t")]);
    }

    #[tokio::test]
    async fn a_subscribe_that_failed_on_the_wire_is_made_when_the_link_is_back() {
        // The one way a subscribe fails: the request did not make it onto the
        // link, because the link went down under it.
        let rig = Rig::new();
        rig.brokers.script_err(BrokerOp::Subscribe, MqttError::Failed("connection reset".into()));
        rig.reconcile(&[plain("n1", "t")]).await;
        assert_eq!(rig.brokers.subscriptions("b"), topics(&[]), "the broker holds nothing");
        let mut seen = rig.brokers.calls().len();

        rig.brokers.set_online("b", false);
        rig.brokers.set_online("b", true);
        rig.settled().await;

        assert_eq!(rig.take_calls(&mut seen), vec![subscribe("t")], "it was not recorded as live");
        assert_eq!(rig.brokers.subscriptions("b"), topics(&["t"]));
    }

    #[tokio::test]
    async fn an_unsubscribe_that_failed_on_the_wire_is_made_when_the_link_is_back() {
        let rig = Rig::new();
        rig.reconcile(&[plain("n1", "t")]).await;
        rig.brokers.script_err(BrokerOp::Unsubscribe, MqttError::Failed("connection reset".into()));
        rig.reconcile(&[]).await;
        assert_eq!(rig.brokers.subscriptions("b"), topics(&["t"]), "the broker still holds it");
        let mut seen = rig.brokers.calls().len();

        rig.brokers.set_online("b", false);
        rig.brokers.set_online("b", true);
        rig.settled().await;

        assert_eq!(rig.take_calls(&mut seen), vec![unsubscribe("t")], "it was not dropped from the live set");
        assert_eq!(rig.brokers.subscriptions("b"), topics(&[]));
    }

    #[tokio::test]
    async fn a_topic_removed_while_its_broker_was_offline_is_unsubscribed_when_the_link_is_back() {
        // The broker keeps its subscriptions while its link is down and
        // subscribes them again when it is back — the removed node's too,
        // unless it is unsubscribed then.
        let rig = Rig::new();
        rig.reconcile(&[bridge("fig", "uid_1")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.brokers.set_online("b", false);
        rig.reconcile(&[]).await;
        assert_eq!(rig.take_calls(&mut seen), vec![], "an offline broker is left alone");

        rig.brokers.set_online("b", true);
        rig.settled().await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                unsubscribe("microflow/uid_1/figma/variable/1-2"),
                publish("microflow/uid_1/app/status", "disconnected", true),
            ]
        );
        assert_eq!(rig.brokers.subscriptions("b"), topics(&[]));
    }

    // --- a Bridge ID and a broker whose link is down ---------------------------------

    /// Bridge ID `uid_1` announced on `b2`, whose link then went down, and the
    /// calls made so far.
    async fn announced_on_a_broker_that_went_offline() -> (Rig, usize) {
        let rig = Rig::new();
        rig.brokers.connect("b2");
        rig.reconcile(&[bridge_on("b2", "fig", "uid_1")]).await;
        rig.brokers.set_online("b2", false);
        let seen = rig.brokers.calls().len();
        (rig, seen)
    }

    /// The link of `broker_id` drops and is back: a pool change with no flow
    /// update.
    async fn bounce(rig: &Rig, broker_id: &str) {
        rig.brokers.set_online(broker_id, false);
        rig.brokers.set_online(broker_id, true);
        rig.settled().await;
    }

    #[tokio::test]
    async fn a_bridge_id_moved_off_a_broker_that_is_offline_is_announced_on_the_new_broker_at_once() {
        // A broker that stopped working is the likeliest reason to move a node:
        // the new broker must not wait for the old one to be told.
        let (rig, mut seen) = announced_on_a_broker_that_went_offline().await;

        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;

        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                subscribe("microflow/uid_1/figma/variable/1-2"),
                publish("microflow/uid_1/app/status", "connected", true),
                publish("microflow/uid_1/app/variables/request", "", false),
            ]
        );
    }

    #[tokio::test]
    async fn the_disconnected_owed_to_an_offline_broker_is_sent_once_when_its_link_is_back() {
        let (rig, mut seen) = announced_on_a_broker_that_went_offline().await;
        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;
        rig.take_calls(&mut seen);

        // The new broker's link bounces, the flow is sent again: the old
        // broker is still offline, and the new one is told only what a new
        // link is told.
        bounce(&rig, "b").await;
        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;
        assert_eq!(rig.take_calls(&mut seen), announced("uid_1"));

        // Two broker ids can name one server: there the late `disconnected`
        // has just replaced the retained `connected`, for a Studio that is
        // still there. So `connected` is said once more where the Bridge ID
        // is — without a new request for the variables.
        rig.brokers.set_online("b2", true);
        rig.settled().await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                on("b2", unsubscribe("microflow/uid_1/figma/variable/1-2")),
                on("b2", publish("microflow/uid_1/app/status", "disconnected", true)),
                publish("microflow/uid_1/app/status", "connected", true),
            ]
        );

        bounce(&rig, "b2").await;
        bounce(&rig, "b").await;
        assert_eq!(rig.take_calls(&mut seen), announced("uid_1"), "it was owed once; `b` is told what a new link is");
    }

    #[tokio::test]
    async fn a_disconnected_owed_to_one_broker_is_said_before_the_connected_on_another_in_the_same_reconcile() {
        // The Bridge ID moves from `b2` to `b` while both links are down, and
        // both are back by the time the performer looks again. Should the two
        // ids name one server, the retained status must end on `connected`.
        let (rig, mut seen) = announced_on_a_broker_that_went_offline().await;
        rig.brokers.set_online("b", false);
        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;
        assert_eq!(rig.take_calls(&mut seen), vec![], "nothing can be said or subscribed on a link that is down");

        rig.brokers.set_online("b2", true);
        rig.brokers.set_online("b", true);
        rig.settled().await;

        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                on("b2", unsubscribe("microflow/uid_1/figma/variable/1-2")),
                subscribe("microflow/uid_1/figma/variable/1-2"),
                on("b2", publish("microflow/uid_1/app/status", "disconnected", true)),
                publish("microflow/uid_1/app/status", "connected", true),
                publish("microflow/uid_1/app/variables/request", "", false),
            ],
            "the goodbye first, and `connected` once"
        );
    }

    #[tokio::test]
    async fn a_disconnected_that_did_not_get_through_on_a_link_that_is_up_is_owed_too() {
        let rig = Rig::new();
        rig.reconcile(&[bridge("fig", "uid_1")]).await;
        let mut seen = rig.brokers.calls().len();
        let goodbye = publish("microflow/uid_1/app/status", "disconnected", true);

        // The design node is deleted, and the link drops under the publish.
        rig.brokers.script_err(BrokerOp::Publish, MqttError::Failed("connection reset".into()));
        rig.reconcile(&[]).await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![unsubscribe("microflow/uid_1/figma/variable/1-2"), goodbye.clone()],
            "the publish that failed"
        );
        assert_eq!(rig.brokers.last_words("b").len(), 1, "owed: and said by the pool should the broker be removed now");

        bounce(&rig, "b").await;
        assert_eq!(rig.take_calls(&mut seen), vec![goodbye], "said when the link is back");
        bounce(&rig, "b").await;
        assert_eq!(rig.take_calls(&mut seen), vec![], "once");
    }

    #[tokio::test]
    async fn a_disconnected_that_did_not_get_through_stays_owed() {
        let (rig, mut seen) = announced_on_a_broker_that_went_offline().await;
        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;
        rig.take_calls(&mut seen);

        // The link drops again under the publish.
        rig.brokers.script_err(BrokerOp::Publish, MqttError::Failed("connection reset".into()));
        rig.brokers.set_online("b2", true);
        rig.settled().await;
        bounce(&rig, "b2").await;

        let goodbye = on("b2", publish("microflow/uid_1/app/status", "disconnected", true));
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                on("b2", unsubscribe("microflow/uid_1/figma/variable/1-2")),
                goodbye.clone(),
                goodbye,
                // Said again after the goodbye that got through.
                publish("microflow/uid_1/app/status", "connected", true),
            ]
        );
    }

    #[tokio::test]
    async fn a_bridge_id_that_moved_back_before_the_disconnected_could_be_sent_is_never_said_to_have_left() {
        let (rig, mut seen) = announced_on_a_broker_that_went_offline().await;
        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;
        rig.take_calls(&mut seen);

        // Back to the old broker, whose link is still down: the Bridge ID
        // leaves `b` and is on no broker until that link is back.
        rig.reconcile(&[bridge_on("b2", "fig", "uid_1")]).await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                unsubscribe("microflow/uid_1/figma/variable/1-2"),
                publish("microflow/uid_1/app/status", "disconnected", true),
            ]
        );

        // The old broker kept the subscription. Studio is announced on it
        // afresh, and asks for the values it missed — on this link and on
        // the next.
        rig.brokers.set_online("b2", true);
        rig.settled().await;
        bounce(&rig, "b2").await;
        let on_b2: Vec<BrokerCall> = announced("uid_1").into_iter().map(|call| on("b2", call)).collect();
        assert_eq!(rig.take_calls(&mut seen), [on_b2.clone(), on_b2].concat(), "no `disconnected` on b2");
    }

    #[tokio::test]
    async fn the_disconnected_owed_to_a_broker_is_dropped_when_its_session_ends() {
        // Connected with a new config, or removed: the session Studio was
        // announced in is gone, and so is what it was owed.
        for end_session in [RecordingMqttBrokers::connect, RecordingMqttBrokers::disconnect] {
            let (rig, mut seen) = announced_on_a_broker_that_went_offline().await;
            rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;
            rig.take_calls(&mut seen);

            end_session(&rig.brokers, "b2");
            rig.settled().await;
            rig.brokers.connect("b2");
            rig.settled().await;
            bounce(&rig, "b2").await;

            assert_eq!(rig.take_calls(&mut seen), vec![]);
        }
    }

    #[tokio::test]
    async fn a_bridge_id_left_on_a_broker_that_is_offline_arrives_there_when_the_link_is_back() {
        // On two brokers, announced on `b`. The node on `b` goes while `b2` is
        // offline: nothing can be said on `b2` until its link is back.
        let rig = Rig::new();
        rig.brokers.connect("b2");
        let on_second = bridge_on("b2", "pen", "uid_1");
        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;
        rig.reconcile(&[bridge_on("b", "fig", "uid_1"), on_second.clone()]).await;
        rig.brokers.set_online("b2", false);
        let mut seen = rig.brokers.calls().len();

        rig.reconcile(std::slice::from_ref(&on_second)).await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                unsubscribe("microflow/uid_1/figma/variable/1-2"),
                publish("microflow/uid_1/app/status", "disconnected", true),
            ]
        );

        rig.brokers.set_online("b2", true);
        rig.settled().await;
        assert_eq!(rig.take_calls(&mut seen), announced("uid_1").into_iter().map(|call| on("b2", call)).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn a_topic_whose_owner_changed_while_its_broker_was_offline_changes_hands_when_the_link_is_back() {
        // Until then the broker holds the old owner's callback, and the live
        // set says so: forgetting it would leave the topic subscribed for good
        // once the flow drops it.
        let mut rig = Rig::new();
        rig.reconcile(&[plain("n1", "t")]).await;
        rig.brokers.set_online("b", false);
        rig.reconcile(&[plain("n2", "t")]).await;
        let mut seen = rig.brokers.calls().len();

        rig.brokers.set_online("b", true);
        rig.settled().await;
        assert_eq!(rig.take_calls(&mut seen), vec![subscribe("t")]);
        assert!(rig.brokers.deliver("b", "t", b"x"));
        let ActorMsg::Deliver { id, .. } = rig.actor.try_recv().expect("delivered") else { panic!("not a Deliver") };
        assert_eq!(id, "n2");

        rig.reconcile(&[]).await;
        assert_eq!(rig.take_calls(&mut seen), vec![unsubscribe("t")]);
        assert_eq!(rig.brokers.subscriptions("b"), topics(&[]));
    }

    // --- what a broker is left to say when its session is ended on purpose ------------
    //
    // That the pool says it, before it closes the link, is tested against a
    // socket (`tests/mqtt_pool.rs`); here, what it is left with.

    /// The `disconnected` of Bridge ID `uid`, as left with a broker.
    fn goodbye(uid: &str) -> LastWord {
        let topic = format!("microflow/{uid}/app/status");
        LastWord { topic, payload: b"disconnected".to_vec(), retain: true }
    }

    #[tokio::test]
    async fn a_broker_is_left_the_goodbye_of_every_bridge_id_announced_on_it() {
        let rig = Rig::new();
        rig.brokers.connect("b2");
        assert_eq!(rig.brokers.last_words("b"), vec![]);

        rig.reconcile(&[bridge("fig", "uid_1"), bridge("pen", "uid_2"), plain("n1", "t")]).await;
        assert_eq!(rig.brokers.last_words("b"), vec![goodbye("uid_1"), goodbye("uid_2")]);
        assert_eq!(rig.brokers.last_words("b2"), vec![], "nothing is announced there");

        // One Bridge ID moves to the other broker, the other leaves the flow:
        // each broker is left what is announced on it now.
        rig.reconcile(&[bridge_on("b2", "fig", "uid_1"), plain("n1", "t")]).await;
        assert_eq!(rig.brokers.last_words("b"), vec![]);
        assert_eq!(rig.brokers.last_words("b2"), vec![goodbye("uid_1")]);
    }

    #[tokio::test]
    async fn a_broker_that_starts_a_new_session_is_left_its_goodbyes_again() {
        // What was left with a session goes with it.
        let rig = Rig::new();
        rig.reconcile(&[bridge("fig", "uid_1")]).await;

        rig.brokers.connect("b");
        assert_eq!(rig.brokers.last_words("b"), vec![], "a new session, with nothing to say yet");
        rig.settled().await;

        assert_eq!(rig.brokers.last_words("b"), vec![goodbye("uid_1")], "announced again, and left again");
    }

    #[tokio::test]
    async fn a_broker_is_left_the_goodbye_it_is_owed_until_it_has_been_said() {
        // The Bridge ID moved off `b2` while its link was down. Should `b2`
        // be removed once its link is back, before the goodbye could be
        // published, it is what the pool says on closing it.
        let (rig, _) = announced_on_a_broker_that_went_offline().await;
        rig.reconcile(&[bridge_on("b", "fig", "uid_1")]).await;
        assert_eq!(rig.brokers.last_words("b2"), vec![goodbye("uid_1")], "owed");
        assert_eq!(rig.brokers.last_words("b"), vec![goodbye("uid_1")], "announced");

        rig.brokers.set_online("b2", true);
        rig.settled().await;
        assert_eq!(rig.brokers.last_words("b2"), vec![], "said: not to be said again");
    }

    // --- a later flow update catches up too ------------------------------------------

    #[tokio::test]
    async fn a_bridge_id_is_announced_only_once_its_subscription_is_in_place() {
        let rig = Rig::new();
        rig.brokers.script_err(BrokerOp::Subscribe, MqttError::Failed("connection reset".into()));
        let mut seen = 0;

        rig.reconcile(&[bridge("fig", "uid_1")]).await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![subscribe("microflow/uid_1/figma/variable/1-2")],
            "no request goes out that nothing would hear the answer to"
        );

        // The flow changes: a node is added. The missing subscription is made
        // along with the new one, and now the Bridge ID is announced.
        rig.reconcile(&[bridge("fig", "uid_1"), plain("n1", "t")]).await;
        assert_eq!(
            rig.take_calls(&mut seen),
            vec![
                subscribe("microflow/uid_1/figma/variable/1-2"),
                subscribe("t"),
                publish("microflow/uid_1/app/status", "connected", true),
                publish("microflow/uid_1/app/variables/request", "", false),
            ]
        );
    }

    // --- reconcile: order -------------------------------------------------------

    #[tokio::test]
    async fn overlapping_reconciles_apply_in_order_and_lose_no_update() {
        // Three flow updates handed over while the first is still on the wire
        // (the recording pool yields inside every subscribe). The last one
        // stands, and nothing an earlier one subscribed is left behind.
        let rig = Rig::new();
        let first = rig.performer.reconcile(vec![plain("n1", "t1")]);
        let second = rig.performer.reconcile(vec![plain("n1", "t1"), plain("n2", "t2")]);
        let third = rig.performer.reconcile(vec![plain("n2", "t2"), plain("n3", "t3")]);
        for reconciled in [first, second, third] {
            reconciled.applied().await;
        }

        assert_eq!(
            rig.brokers.calls(),
            vec![subscribe("t1"), subscribe("t2"), unsubscribe("t1"), subscribe("t3")]
        );
        assert_eq!(rig.brokers.subscriptions("b"), topics(&["t2", "t3"]));

        rig.reconcile(&[]).await;
        assert_eq!(rig.brokers.subscriptions("b"), topics(&[]), "every subscription was tracked");
    }
}
