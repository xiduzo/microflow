//! An in-process MQTT broker for the socket tests: it speaks just enough MQTT 5
//! to be connected, subscribed to and published from, records what it saw, and
//! can be made to misbehave the way networks do — cut its links, take
//! connections and answer nothing, or stop reading what it is sent.
//!
//! Shared by the test crates in this directory (`#[path]`-included), each of
//! which uses a part of it.
#![allow(dead_code)]

use app_lib::mqtt::broker::BrokerConfig;
use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, watch};

/// How long anything is waited for before the test fails.
pub const PATIENCE: Duration = Duration::from_secs(10);

/// What the broker saw, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    /// The n-th connection (from 1) completed CONNECT.
    Connected(usize),
    /// A SUBSCRIBE for `topic` on connection `connection`.
    Subscribed { connection: usize, topic: String },
    /// An UNSUBSCRIBE for `topic` on connection `connection`.
    Unsubscribed { connection: usize, topic: String },
}

pub fn subscribed(connection: usize, topic: &str) -> Seen {
    Seen::Subscribed { connection, topic: topic.into() }
}

pub fn unsubscribed(connection: usize, topic: &str) -> Seen {
    Seen::Unsubscribed { connection, topic: topic.into() }
}

/// What a client sent besides the above, in order. Kept apart from [`Seen`],
/// so that a test counting connects and subscribes is not thrown off by a
/// client that says goodbye.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Heard {
    /// A PUBLISH on connection `connection`.
    Published { connection: usize, topic: String, payload: String, retain: bool },
    /// A DISCONNECT on connection `connection`.
    Disconnected(usize),
}

pub fn published(connection: usize, topic: &str, payload: &str, retain: bool) -> Heard {
    Heard::Published { connection, topic: topic.into(), payload: payload.into(), retain }
}

/// A broker that accepts every CONNECT and SUBSCRIBE, can cut its links, and
/// can go silent: take connections and answer nothing, until it is told to
/// answer again — all of them, or one connection at a time.
///
/// It handles the RETAIN flag as a real broker does: a SUBSCRIBE — every one,
/// also a repeated one — is answered with the retained messages its filter
/// matches, flagged; a live publish goes out unflagged. A client's PUBLISH with
/// RETAIN sets its topic's retained message, an empty one clears it.
///
/// A live publish goes to every open connection, whatever it subscribed:
/// routing by filter is the client's side, which is what these tests are
/// about. Once a connection, at least: after
/// [`copy_per_subscription`](Self::copy_per_subscription) a connection gets
/// one copy for each of its filters that match the topic, as MQTT 5 §3.3.4
/// allows and mosquitto 2 does.
///
/// A client that publishes on a topic that is not a topic name (a wildcard in
/// it, or empty) has its connection closed, as a broker must (MQTT 5 §4.13).
pub struct FakeBroker {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
    heard: Arc<Mutex<Vec<Heard>>>,
    /// Bumped to make every open connection close.
    cut: watch::Sender<u64>,
    /// `(topic, payload)` to send to every open connection.
    outbound: broadcast::Sender<(String, Vec<u8>)>,
    /// While set, a live publish goes out once per matching filter.
    copies: watch::Sender<bool>,
    /// The retained message of each topic.
    retained: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    /// While set, a CONNECT gets no answer.
    silent: watch::Sender<bool>,
    /// The connections that are answered although the broker is silent.
    let_through: watch::Sender<BTreeSet<usize>>,
    /// While set, nothing a client sends is read.
    deaf: watch::Sender<bool>,
    /// The connections that got their CONNACK and are still open.
    open: Arc<AtomicUsize>,
    /// The connections whose CONNECT is waiting for an answer.
    waiting: Arc<AtomicUsize>,
    /// The connections whose CONNECT was ever kept waiting.
    held: Arc<AtomicUsize>,
    /// The connections taken, whatever became of them.
    taken: Arc<AtomicUsize>,
}

impl FakeBroker {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let heard = Arc::new(Mutex::new(Vec::new()));
        let retained = Arc::new(Mutex::new(BTreeMap::new()));
        let (cut, _) = watch::channel(0);
        let (outbound, _) = broadcast::channel(16);
        let (silent, _) = watch::channel(false);
        let (copies, _) = watch::channel(false);
        let (let_through, _) = watch::channel(BTreeSet::new());
        let (deaf, _) = watch::channel(false);
        let open = Arc::new(AtomicUsize::new(0));
        let waiting = Arc::new(AtomicUsize::new(0));
        let held = Arc::new(AtomicUsize::new(0));
        let taken = Arc::new(AtomicUsize::new(0));
        let (accept_seen, accept_heard, accept_retained) = (Arc::clone(&seen), Arc::clone(&heard), Arc::clone(&retained));
        let (accept_cut, accept_outbound, accept_silent) = (cut.clone(), outbound.clone(), silent.clone());
        let (accept_let_through, accept_deaf, accept_copies) = (let_through.clone(), deaf.clone(), copies.clone());
        let (accept_open, accept_waiting) = (Arc::clone(&open), Arc::clone(&waiting));
        let (accept_held, accept_taken) = (Arc::clone(&held), Arc::clone(&taken));
        tokio::spawn(async move {
            let mut connection = 0;
            while let Ok((stream, _)) = listener.accept().await {
                connection += 1;
                accept_taken.fetch_add(1, Ordering::SeqCst);
                let link = Link {
                    connection,
                    seen: Arc::clone(&accept_seen),
                    heard: Arc::clone(&accept_heard),
                    retained: Arc::clone(&accept_retained),
                    cut: accept_cut.subscribe(),
                    outbound: accept_outbound.subscribe(),
                    copies: accept_copies.subscribe(),
                    filters: BTreeSet::new(),
                    silent: accept_silent.subscribe(),
                    let_through: accept_let_through.subscribe(),
                    deaf: accept_deaf.subscribe(),
                    open: Arc::clone(&accept_open),
                    waiting: Arc::clone(&accept_waiting),
                    held: Arc::clone(&accept_held),
                };
                tokio::spawn(link.serve(stream));
            }
        });
        Self { addr, seen, heard, cut, outbound, copies, retained, silent, let_through, deaf, open, waiting, held, taken }
    }

    /// From here on, send a live publish to a connection once for each of its
    /// filters that match the topic (and still once to one with none).
    pub fn copy_per_subscription(&self) {
        self.copies.send_replace(true);
    }

    pub fn config(&self) -> BrokerConfig {
        BrokerConfig { id: "b".into(), url: format!("mqtt://{}", self.addr), username: None, password: None }
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// What clients published, and which of them said goodbye, in order.
    pub fn heard(&self) -> Vec<Heard> {
        self.heard.lock().unwrap().clone()
    }

    /// Close every open connection, as a network drop does.
    pub fn cut_links(&self) {
        self.cut.send_modify(|generation| *generation += 1);
    }

    /// From here on, take connections and leave their CONNECT unanswered: a
    /// host that is there and says nothing.
    pub fn go_silent(&self) {
        self.silent.send_replace(true);
    }

    /// Answer again: the connections whose client is still waiting for its
    /// CONNACK, and the ones that come from here on.
    pub fn answer_again(&self) {
        self.silent.send_replace(false);
    }

    /// Answer the `connection`-th connection (from 1) although the broker is
    /// silent: of several clients waiting, this one gets through.
    pub fn answer(&self, connection: usize) {
        self.let_through.send_modify(|connections| {
            connections.insert(connection);
        });
    }

    /// From here on, read nothing the clients send: their writes pile up in
    /// the socket until it takes no more, as on a link that stalled.
    pub fn go_deaf(&self) {
        self.deaf.send_replace(true);
    }

    /// Read what the clients send again.
    pub fn listen_again(&self) {
        self.deaf.send_replace(false);
    }

    /// How many connections the broker has taken so far, whatever became of
    /// them.
    pub fn taken(&self) -> usize {
        self.taken.load(Ordering::SeqCst)
    }

    /// Poll until `count` connections have been taken.
    pub async fn wait_until_taken(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.taken() < count {
            assert!(tokio::time::Instant::now() < deadline, "{} connections were taken", self.taken());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Poll until `count` connections have had their CONNECT kept waiting,
    /// counting the ones that went away or were answered since.
    pub async fn wait_until_held(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.held.load(Ordering::SeqCst) < count {
            let held = self.held.load(Ordering::SeqCst);
            assert!(tokio::time::Instant::now() < deadline, "{held} connections were kept waiting");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Poll until exactly `count` connections are waiting for an answer to
    /// their CONNECT.
    pub async fn wait_until_waiting(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.waiting.load(Ordering::SeqCst) != count {
            let waiting = self.waiting.load(Ordering::SeqCst);
            assert!(tokio::time::Instant::now() < deadline, "{waiting} connections are waiting");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Poll until exactly `count` connections that completed CONNECT are open.
    pub async fn wait_until_open(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.open.load(Ordering::SeqCst) != count {
            let open = self.open.load(Ordering::SeqCst);
            assert!(tokio::time::Instant::now() < deadline, "{open} connections are open");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// A live publish on `topic`: unflagged, to every open connection.
    pub fn publish(&self, topic: &str, payload: &[u8]) {
        let _ = self.outbound.send((topic.to_string(), payload.to_vec()));
    }

    /// Make `payload` the retained message of `topic`, for the SUBSCRIBEs to
    /// come. (The live publish that carries a retained message in is left out:
    /// a test that wants one calls [`Self::publish`].)
    pub fn retain(&self, topic: &str, payload: &[u8]) {
        self.retained.lock().unwrap().insert(topic.to_string(), payload.to_vec());
    }

    /// Poll until the broker has seen `count` events. A client's `subscribe`
    /// returns when the packet is written, not when the broker has read it.
    pub async fn wait_until_seen(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.seen().len() < count {
            assert!(tokio::time::Instant::now() < deadline, "the broker saw only {:?}", self.seen());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Poll until the broker has heard `count` things.
    pub async fn wait_until_heard(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.heard().len() < count {
            assert!(tokio::time::Instant::now() < deadline, "the broker heard only {:?}", self.heard());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

/// One connection to the [`FakeBroker`].
struct Link {
    connection: usize,
    seen: Arc<Mutex<Vec<Seen>>>,
    heard: Arc<Mutex<Vec<Heard>>>,
    retained: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    cut: watch::Receiver<u64>,
    outbound: broadcast::Receiver<(String, Vec<u8>)>,
    copies: watch::Receiver<bool>,
    /// The topic filters this connection subscribed and still holds.
    filters: BTreeSet<String>,
    silent: watch::Receiver<bool>,
    let_through: watch::Receiver<BTreeSet<usize>>,
    deaf: watch::Receiver<bool>,
    open: Arc<AtomicUsize>,
    waiting: Arc<AtomicUsize>,
    held: Arc<AtomicUsize>,
}

impl Link {
    /// Serve the connection until it ends, keeping the broker's count of open
    /// connections.
    pub async fn serve(mut self, stream: TcpStream) {
        let mut connected = false;
        self.run(stream, &mut connected).await;
        if connected {
            self.open.fetch_sub(1, Ordering::SeqCst);
        }
    }

    /// Answer CONNECT, SUBSCRIBE, UNSUBSCRIBE and PINGREQ, note PUBLISH and
    /// DISCONNECT, and pass on what the broker publishes, until the client
    /// leaves or the links are cut. `connected` is set once the CONNECT is
    /// answered.
    pub async fn run(&mut self, mut stream: TcpStream, connected: &mut bool) {
        loop {
            // A deaf broker reads nothing until it listens again.
            if *self.deaf.borrow() {
                tokio::select! {
                    _ = self.cut.changed() => return,
                    listening = self.deaf.wait_for(|deaf| !*deaf) => {
                        if listening.is_err() {
                            return;
                        }
                    }
                }
            }
            let packet = tokio::select! {
                _ = self.cut.changed() => return,
                _ = self.deaf.changed() => continue,
                message = self.outbound.recv() => {
                    let Ok((topic, payload)) = message else { return };
                    let matching = self.filters.iter().filter(|filter| filter_matches(filter, &topic)).count();
                    let copies = if *self.copies.borrow() { matching.max(1) } else { 1 };
                    if stream.write_all(&publish_packet(&topic, &payload, false).repeat(copies)).await.is_err() {
                        return;
                    }
                    continue;
                }
                packet = read_packet(&mut stream) => packet,
            };
            let Some((first, body)) = packet else { return };
            let mut reply: Vec<u8> = Vec::new();
            match first & 0xF0 {
                // CONNECT → CONNACK: no session present, success, no properties.
                // A silent broker holds the connection, and answers it when it
                // speaks again — if the client is still there.
                0x10 => {
                    if *self.silent.borrow() {
                        self.waiting.fetch_add(1, Ordering::SeqCst);
                        self.held.fetch_add(1, Ordering::SeqCst);
                        let connection = self.connection;
                        let still_there = tokio::select! {
                            _ = self.cut.changed() => false,
                            // Anything from the client now is it going away.
                            _ = read_packet(&mut stream) => false,
                            spoke = self.silent.wait_for(|silent| !*silent) => spoke.is_ok(),
                            through = self.let_through.wait_for(|connections| connections.contains(&connection)) => {
                                through.is_ok()
                            }
                        };
                        self.waiting.fetch_sub(1, Ordering::SeqCst);
                        if !still_there {
                            return;
                        }
                    }
                    self.see(Seen::Connected(self.connection));
                    self.open.fetch_add(1, Ordering::SeqCst);
                    *connected = true;
                    reply.extend([0x20, 0x03, 0x00, 0x00, 0x00]);
                }
                // PUBLISH at QoS 0: noted, kept when it is retained, and
                // routed nowhere. One on a topic that is not a topic name
                // closes the connection.
                0x30 => {
                    let (topic, payload) = published_message(&body);
                    let retain = first & 0x01 != 0;
                    let valid = !topic.is_empty() && !topic.contains(['+', '#']);
                    if valid && retain {
                        let mut retained = self.retained.lock().unwrap();
                        if payload.is_empty() {
                            retained.remove(&topic);
                        } else {
                            retained.insert(topic.clone(), payload.clone().into_bytes());
                        }
                    }
                    self.hear(Heard::Published { connection: self.connection, topic, payload, retain });
                    if !valid {
                        return;
                    }
                    continue;
                }
                // SUBSCRIBE → SUBACK (packet id, no properties, granted QoS 0),
                // then the retained messages the filter matches, flagged.
                0x80 => {
                    let filter = first_topic(&body);
                    reply.extend([0x90, 0x04, body[0], body[1], 0x00, 0x00]);
                    for (topic, payload) in self.retained.lock().unwrap().iter() {
                        if filter_matches(&filter, topic) {
                            reply.extend(publish_packet(topic, payload, true));
                        }
                    }
                    self.filters.insert(filter.clone());
                    self.see(Seen::Subscribed { connection: self.connection, topic: filter });
                }
                // UNSUBSCRIBE → UNSUBACK.
                0xA0 => {
                    let filter = first_topic(&body);
                    self.filters.remove(&filter);
                    self.see(Seen::Unsubscribed { connection: self.connection, topic: filter });
                    reply.extend([0xB0, 0x04, body[0], body[1], 0x00, 0x00]);
                }
                // PINGREQ → PINGRESP.
                0xC0 => reply.extend([0xD0, 0x00]),
                // DISCONNECT.
                0xE0 => {
                    self.hear(Heard::Disconnected(self.connection));
                    return;
                }
                _ => continue,
            }
            if stream.write_all(&reply).await.is_err() {
                return;
            }
        }
    }

    pub fn see(&self, seen: Seen) {
        self.seen.lock().unwrap().push(seen);
    }

    pub fn hear(&self, heard: Heard) {
        self.heard.lock().unwrap().push(heard);
    }
}

/// The first topic filter of a SUBSCRIBE or UNSUBSCRIBE body: packet id (2),
/// property length (1, zero), then the filter as a length-prefixed string.
pub fn first_topic(body: &[u8]) -> String {
    let length = usize::from(u16::from_be_bytes([body[3], body[4]]));
    String::from_utf8_lossy(&body[5..5 + length]).to_string()
}

/// The topic and payload of a client's PUBLISH at `QoS` 0: the topic as a
/// length-prefixed string, the properties (their length in one byte, then that
/// many bytes), then the payload.
pub fn published_message(body: &[u8]) -> (String, String) {
    let length = usize::from(u16::from_be_bytes([body[0], body[1]]));
    let topic = String::from_utf8_lossy(&body[2..2 + length]).to_string();
    let properties = usize::from(body[2 + length]);
    let payload = String::from_utf8_lossy(&body[2 + length + 1 + properties..]).to_string();
    (topic, payload)
}

/// Whether the broker sends a message on `topic` for a subscription to
/// `filter` (with `+` and `#`). Written apart from the client's matcher, so
/// that a mistake there is not made here too.
pub fn filter_matches(filter: &str, topic: &str) -> bool {
    if topic.starts_with('$') && (filter.starts_with('+') || filter.starts_with('#')) {
        return false;
    }
    let mut levels = topic.split('/');
    for want in filter.split('/') {
        match (want, levels.next()) {
            ("#", _) => return true,
            ("+", Some(_)) => {}
            (want, Some(level)) if want == level => {}
            _ => return false,
        }
    }
    levels.next().is_none()
}

/// A PUBLISH at `QoS` 0, with or without the RETAIN flag: topic as a
/// length-prefixed string, no properties, payload. Short enough here for a
/// one-byte remaining length.
pub fn publish_packet(topic: &str, payload: &[u8], retain: bool) -> Vec<u8> {
    let remaining = 2 + topic.len() + 1 + payload.len();
    let mut packet = vec![0x30 | u8::from(retain), u8::try_from(remaining).expect("a short test packet")];
    packet.extend_from_slice(&u16::try_from(topic.len()).expect("a short topic").to_be_bytes());
    packet.extend_from_slice(topic.as_bytes());
    packet.push(0x00);
    packet.extend_from_slice(payload);
    packet
}

/// One MQTT control packet: its first byte (the type in the high nibble, the
/// flags in the low one) and its body. `None` when the client closed the
/// connection.
pub async fn read_packet(stream: &mut TcpStream) -> Option<(u8, Vec<u8>)> {
    let first = stream.read_u8().await.ok()?;
    let mut length = 0usize;
    let mut shift = 0;
    loop {
        let byte = stream.read_u8().await.ok()?;
        length |= usize::from(byte & 0x7F) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.ok()?;
    Some((first, body))
}

// --- a relay in front of the broker ----------------------------------------------
//
// Kept apart from the broker above so that each can change without the other:
// the relay knows only the MQTT fixed header, CONNECT's will, and TCP.

/// MQTT control packet types, as the high nibble of a packet's first byte.
pub const CONNECT: u8 = 0x10;
pub const PUBLISH: u8 = 0x30;
pub const SUBSCRIBE: u8 = 0x80;

/// The will a client's CONNECT carried: `(topic, payload, retain)`.
pub type Will = (String, String, bool);

/// A TCP relay between the clients and a [`FakeBroker`]: what a client sends
/// is read packet by packet and passed on, what the broker sends is passed
/// back as it comes. It notes each CONNECT's will, and can be told to stop
/// reading a client at a packet of a given type — the packet's first bytes
/// read, the rest left in the socket — until it is told to go on: a client
/// whose write is larger than the socket takes is then held in the middle of
/// it, for as long as a test needs, and a test learns when that is.
pub struct Relay {
    addr: SocketAddr,
    /// The will of each CONNECT read so far, by connection (from 1).
    wills: Arc<Mutex<BTreeMap<usize, Option<Will>>>>,
    /// The packet type the relay stops at, while one is set.
    hold: watch::Sender<Option<u8>>,
    /// The connections stopped at a packet right now.
    holding: Arc<AtomicUsize>,
}

impl Relay {
    /// A relay to `broker`, listening on a port of its own.
    pub async fn start(broker: &FakeBroker) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let upstream = broker.addr;
        let wills = Arc::new(Mutex::new(BTreeMap::new()));
        let (hold, _) = watch::channel(None);
        let holding = Arc::new(AtomicUsize::new(0));
        let (accept_wills, accept_hold, accept_holding) = (Arc::clone(&wills), hold.clone(), Arc::clone(&holding));
        tokio::spawn(async move {
            let mut connection = 0;
            while let Ok((client, _)) = listener.accept().await {
                connection += 1;
                let Ok(server) = TcpStream::connect(upstream).await else { continue };
                let passage = Passage {
                    connection,
                    wills: Arc::clone(&accept_wills),
                    hold: accept_hold.subscribe(),
                    holding: Arc::clone(&accept_holding),
                };
                tokio::spawn(passage.run(client, server));
            }
        });
        Self { addr, wills, hold, holding }
    }

    /// Broker `b`, reached through this relay.
    pub fn config(&self) -> BrokerConfig {
        BrokerConfig { id: "b".into(), url: format!("mqtt://{}", self.addr), username: None, password: None }
    }

    /// The will each CONNECT read so far carried, by connection (from 1).
    pub fn wills(&self) -> BTreeMap<usize, Option<Will>> {
        self.wills.lock().unwrap().clone()
    }

    /// From here on, stop reading a client at its next packet of type
    /// `packet_type` ([`PUBLISH`], [`SUBSCRIBE`], …), until [`Self::go_on`].
    pub fn hold_at(&self, packet_type: u8) {
        self.hold.send_replace(Some(packet_type));
    }

    /// Read on: the held clients, and every packet from here on.
    pub fn go_on(&self) {
        self.hold.send_replace(None);
    }

    /// Poll until `count` connections are stopped at a packet.
    pub async fn wait_until_holding(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.holding.load(Ordering::SeqCst) < count {
            assert!(tokio::time::Instant::now() < deadline, "{} connections are held", self.holding.load(Ordering::SeqCst));
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Poll until `count` connections have sent their CONNECT.
    pub async fn wait_until_connected(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.wills().len() < count {
            assert!(tokio::time::Instant::now() < deadline, "{} connections were made", self.wills().len());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

/// One client's connection through the [`Relay`].
struct Passage {
    connection: usize,
    wills: Arc<Mutex<BTreeMap<usize, Option<Will>>>>,
    hold: watch::Receiver<Option<u8>>,
    holding: Arc<AtomicUsize>,
}

impl Passage {
    /// Relay until either side closes; then close the other.
    async fn run(mut self, client: TcpStream, server: TcpStream) {
        let (mut from_client, mut to_client) = client.into_split();
        let (mut from_server, mut to_server) = server.into_split();
        tokio::select! {
            _ = tokio::io::copy(&mut from_server, &mut to_client) => {}
            () = self.pass_on(&mut from_client, &mut to_server) => {}
        }
    }

    /// Read the client's packets and write them to the broker, stopping at
    /// a packet of the type the relay holds at.
    async fn pass_on(&mut self, from: &mut tokio::net::tcp::OwnedReadHalf, to: &mut tokio::net::tcp::OwnedWriteHalf) {
        loop {
            let Ok(first) = from.read_u8().await else { return };
            let mut header = vec![first];
            let mut length = 0usize;
            let mut shift = 0;
            loop {
                let Ok(byte) = from.read_u8().await else { return };
                header.push(byte);
                length |= usize::from(byte & 0x7F) << shift;
                if byte & 0x80 == 0 {
                    break;
                }
                shift += 7;
            }
            if *self.hold.borrow() == Some(first & 0xF0) {
                // Counted while stopped here, also when the connection ends
                // meanwhile.
                let _held = Held::new(&self.holding);
                let _ = self.hold.wait_for(|hold| *hold != Some(first & 0xF0)).await;
            }
            let mut body = vec![0; length];
            if from.read_exact(&mut body).await.is_err() {
                return;
            }
            if first & 0xF0 == CONNECT {
                self.wills.lock().unwrap().insert(self.connection, will_of(&body));
            }
            if to.write_all(&header).await.is_err() || to.write_all(&body).await.is_err() {
                return;
            }
        }
    }
}

/// One connection stopped at a packet, for as long as it lives.
struct Held<'a>(&'a AtomicUsize);

impl<'a> Held<'a> {
    fn new(holding: &'a AtomicUsize) -> Self {
        holding.fetch_add(1, Ordering::SeqCst);
        Self(holding)
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The will in the body of an MQTT 5 CONNECT, if it has one.
fn will_of(body: &[u8]) -> Option<Will> {
    // Protocol name (a length-prefixed "MQTT"), level, flags, keep alive.
    let name = usize::from(u16::from_be_bytes([body[0], body[1]]));
    let flags = body[2 + name + 1];
    let mut at = 2 + name + 1 + 1 + 2;
    let skip_properties = |at: &mut usize| {
        let (mut length, mut shift) = (0usize, 0);
        loop {
            let byte = body[*at];
            *at += 1;
            length |= usize::from(byte & 0x7F) << shift;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        *at += length;
    };
    let string = |at: &mut usize| {
        let length = usize::from(u16::from_be_bytes([body[*at], body[*at + 1]]));
        let text = String::from_utf8_lossy(&body[*at + 2..*at + 2 + length]).to_string();
        *at += 2 + length;
        text
    };
    skip_properties(&mut at);
    let _client_id = string(&mut at);
    if flags & 0x04 == 0 {
        return None;
    }
    skip_properties(&mut at);
    let topic = string(&mut at);
    let payload = string(&mut at);
    Some((topic, payload, flags & 0x20 != 0))
}
