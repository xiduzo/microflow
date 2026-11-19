//! Will links: a broker session's goodbyes after the first, each left with the
//! broker as the will of an idle link of its own.
//!
//! MQTT gives a link one will, fixed at CONNECT. The session's main link
//! carries the first of its last words ([`super::MqttManager::set_last_words`]);
//! every further one that a CONNECT can carry gets a **will link**: its own
//! CONNECT, with a fresh random client id and that goodbye as its will, no
//! subscriptions, the keepalive only. Should the app end without a goodbye,
//! every link ends with it, and the broker publishes every will.
//!
//! A will link publishes one message in its life: its goodbye, the message
//! its will is, right before its DISCONNECT, on its own connection — so the
//! broker has the goodbye before it drops the will. It does so when its
//! goodbye is no longer left with the session (the Bridge ID left), and when
//! the session ends on purpose, beside the main link's last words. A will
//! link whose goodbye is still owed but moves elsewhere — to the main link, or
//! to a will link that replaces it because the goodbye changed — says only
//! DISCONNECT, once the other link carries it (make before break). A will
//! link that is down (waiting to be opened again) is not told anything; one
//! that is being opened is opened to the end and then told, since its will
//! may be with the broker already. A goodbye that does not get through in
//! time ([`LAST_WORDS_TIMEOUT`]) has the link cut, which leaves the broker to
//! publish the will. At a session's end the main link says the goodbyes of
//! the will links that are not up. A will link that cannot be opened, or drops, is opened
//! again by the backoff the main link repairs itself by. Nothing about a will
//! link is the broker's status: it is not the connection anybody sees.

use super::broker::{say_disconnect, say_word, BrokerConfig, ClientEndpoint, Dialer, LastWord, ReconnectConfig};
use super::manager::LAST_WORDS_TIMEOUT;
use mqtt_endpoint_tokio::mqtt_ep;
use std::collections::HashMap;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

/// How a will link ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Farewell {
    /// Publish the goodbye, then say DISCONNECT: the broker drops the will.
    Goodbye,
    /// Say DISCONNECT only: the goodbye is owed elsewhere now.
    Disconnect,
    /// Cut the link: the broker publishes the will.
    Cut,
}

/// One idle link that holds one will.
struct WillLink {
    will: LastWord,
    /// Tells the link's task how to end. Dropped unsent, it ends as
    /// [`Farewell::Cut`].
    end: oneshot::Sender<Farewell>,
    /// Whether the link is up right now.
    up: watch::Receiver<bool>,
    task: JoinHandle<()>,
}

impl WillLink {
    fn open(config: &BrokerConfig, will: LastWord, reconnect: &ReconnectConfig) -> Self {
        let dialer = Dialer::for_will(config.clone(), will.clone(), reconnect.connect_timeout);
        let (end, ended) = oneshot::channel();
        let (is_up, up) = watch::channel(false);
        let task = tokio::spawn(hold(dialer, will.clone(), config.id.clone(), reconnect.clone(), ended, is_up));
        Self { will, end, up, task }
    }

    /// End the link as `farewell` says, and wait until it has.
    async fn close(self, farewell: Farewell) {
        let _ = self.end.send(farewell);
        let _ = self.task.await;
    }
}

/// Keep a link up that leaves `will` with the broker, until told how to end:
/// open it, keep it (the endpoint sends the keepalive), and open it again by
/// `reconnect`'s backoff whenever it cannot be opened or drops.
async fn hold(
    dialer: Dialer,
    will: LastWord,
    broker_id: String,
    reconnect: ReconnectConfig,
    mut ended: oneshot::Receiver<Farewell>,
    up: watch::Sender<bool>,
) {
    let mut delay = reconnect.initial_delay;
    let mut attempts = 0;
    loop {
        let opening = dialer.open();
        tokio::pin!(opening);
        let opened = tokio::select! {
            opened = &mut opening => opened,
            farewell = &mut ended => {
                // Told to end while the link is being opened. Its CONNECT —
                // and with it the will — may have reached the broker already:
                // dropped here, the link would leave the will to be published.
                // So it is opened to the end (bounded by the connect timeout)
                // and then ended as told. Only a cut needs no answer.
                let farewell = farewell.unwrap_or(Farewell::Cut);
                if farewell != Farewell::Cut {
                    if let Ok(opened) = opening.await {
                        end(&opened.endpoint, &will, farewell, &reconnect, &broker_id).await;
                    }
                }
                return;
            }
        };
        match opened {
            Ok(opened) => {
                let endpoint = opened.endpoint;
                up.send_replace(true);
                delay = reconnect.initial_delay;
                attempts = 0;
                let farewell = tokio::select! {
                    farewell = &mut ended => Some(farewell.unwrap_or(Farewell::Cut)),
                    () = until_lost(&endpoint) => None,
                };
                up.send_replace(false);
                if let Some(farewell) = farewell {
                    end(&endpoint, &will, farewell, &reconnect, &broker_id).await;
                    return;
                }
                log::warn!("[MQTT] Broker {broker_id}: a will link dropped; opening it again");
                let _ = endpoint.close().await;
            }
            Err(e) => log::warn!("[MQTT] Broker {broker_id}: a will link could not be opened: {e}"),
        }
        attempts += 1;
        if reconnect.max_attempts.is_some_and(|max| attempts >= max) {
            log::error!("[MQTT] Broker {broker_id}: giving up on a will link after {attempts} attempts");
            // Waits to be told to end, so that whoever closes it finds it.
            let _ = ended.await;
            return;
        }
        tokio::select! {
            _ = &mut ended => return,
            () = tokio::time::sleep(delay) => {}
        }
        delay = reconnect.next_delay(delay);
    }
}

/// End a link that is up as `farewell` says.
async fn end(endpoint: &ClientEndpoint, will: &LastWord, farewell: Farewell, reconnect: &ReconnectConfig, broker_id: &str) {
    let disconnect = match farewell {
        Farewell::Goodbye => match tokio::time::timeout(LAST_WORDS_TIMEOUT, say_word(endpoint, will)).await {
            Ok(Ok(())) => true,
            Ok(Err(e)) => {
                log::warn!("[MQTT] Broker {broker_id}: a will link did not take its goodbye ({e}); leaving it to the will");
                false
            }
            Err(_) => {
                log::warn!("[MQTT] Broker {broker_id}: a will link took too long over its goodbye; leaving it to the will");
                false
            }
        },
        Farewell::Disconnect => true,
        Farewell::Cut => false,
    };
    if disconnect {
        say_disconnect(endpoint, reconnect.write_timeout).await;
    }
    let _ = endpoint.close().await;
}

/// Resolves when the link drops: a receive fails, or the broker says
/// DISCONNECT. What else arrives — PINGRESP — is taken and let go.
async fn until_lost(endpoint: &ClientEndpoint) {
    loop {
        match endpoint.recv().await {
            Ok(mqtt_ep::packet::Packet::V5_0Disconnect(_)) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

/// The will links of one broker session, by the topic of the will each holds.
#[derive(Default)]
pub(super) struct WillLinks {
    links: HashMap<String, WillLink>,
}

/// Will links a session no longer holds, still to be closed.
#[must_use]
pub(super) struct Retired {
    links: Vec<Retiring>,
}

/// A will link to be closed, how, and — for one whose goodbye is now carried
/// by another link that is being opened — once that one is up, or gave up.
struct Retiring {
    link: WillLink,
    farewell: Farewell,
    after: Option<watch::Receiver<bool>>,
}

impl WillLinks {
    /// The goodbyes after the first of `words` that get a will link: each
    /// that a CONNECT can carry, once per topic, and not the first's topic,
    /// which the main link carries.
    fn further(words: &[LastWord]) -> Vec<LastWord> {
        let first = words.first().filter(|first| first.fits_a_will()).map(|first| first.topic.as_str());
        let mut topics: Vec<&str> = first.into_iter().collect();
        let mut further = Vec::new();
        for word in words.iter().skip(1).filter(|word| word.fits_a_will()) {
            if !topics.contains(&word.topic.as_str()) {
                topics.push(&word.topic);
                further.push(word.clone());
            }
        }
        further
    }

    /// Hold the will links `words` call for from here on — one for each of
    /// its goodbyes after the first ([`Self::further`]): one is opened for a
    /// goodbye that has none, and one whose goodbye changed is replaced.
    /// Returns the links the session no longer holds, for the caller to
    /// [close](Retired::close) once the main link carries its new will: one
    /// whose goodbye is no longer among `words` says it, one whose goodbye
    /// went elsewhere says only DISCONNECT.
    pub(super) fn hold(&mut self, words: &[LastWord], config: &BrokerConfig, reconnect: &ReconnectConfig) -> Retired {
        let wanted: HashMap<String, LastWord> =
            Self::further(words).into_iter().map(|will| (will.topic.clone(), will)).collect();
        let mut retired = Vec::new();
        let gone: Vec<String> = self.links.keys().filter(|topic| !wanted.contains_key(*topic)).cloned().collect();
        for topic in gone {
            if let Some(link) = self.links.remove(&topic) {
                let still_owed = words.iter().any(|word| word.topic == topic);
                let farewell = if still_owed { Farewell::Disconnect } else { Farewell::Goodbye };
                retired.push(Retiring { link, farewell, after: None });
            }
        }
        for (topic, will) in wanted {
            if self.links.get(&topic).is_some_and(|link| link.will == will) {
                continue;
            }
            let link = WillLink::open(config, will, reconnect);
            let after = Some(link.up.clone());
            if let Some(old) = self.links.insert(topic, link) {
                retired.push(Retiring { link: old, farewell: Farewell::Disconnect, after });
            }
        }
        Retired { links: retired }
    }

    /// How many of the will links are up.
    pub(super) fn up(&self) -> usize {
        self.links.values().filter(|link| *link.up.borrow()).count()
    }

    /// Every will link, taken out of the session, which is ending: each that
    /// is up says its goodbye. Returned with the topics of those that are up
    /// — whose goodbyes the main link need not say.
    pub(super) fn take_all(&mut self) -> (Retired, Vec<String>) {
        let mut saying = Vec::new();
        let links = self
            .links
            .drain()
            .map(|(topic, link)| {
                if *link.up.borrow() {
                    saying.push(topic);
                }
                Retiring { link, farewell: Farewell::Goodbye, after: None }
            })
            .collect();
        (Retired { links }, saying)
    }
}

impl Retired {
    pub(super) fn is_empty(&self) -> bool {
        self.links.is_empty()
    }

    /// Close every link, all at once, as it is to be closed.
    pub(super) async fn close(self) {
        let mut closing = tokio::task::JoinSet::new();
        for Retiring { link, farewell, after } in self.links {
            closing.spawn(async move {
                if let Some(mut after) = after {
                    let _ = after.wait_for(|up| *up).await;
                }
                link.close(farewell).await;
            });
        }
        while closing.join_next().await.is_some() {}
    }
}
