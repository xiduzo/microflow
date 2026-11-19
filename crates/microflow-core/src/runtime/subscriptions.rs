//! Subscription reconciliation policy — shared by both **Runtime Host**s.
//!
//! A flow's subscribe nodes each return a [`SubscriberWiring`]; several can
//! resolve to the same `(broker_id, topic)`, but a broker keeps exactly one
//! callback per topic. Collapsing the wirings to one **desired** subscription per
//! topic — and picking a *deterministic* winner when they collide — is policy
//! BOTH hosts must apply identically, or the desktop and browser would disagree
//! on which node owns a topic. This is the single source: the desktop
//! `CloudPerformer` (`apps/web/src-tauri/src/runtime/cloud_performer.rs`) calls
//! [`reconcile_desired`] directly, the browser one
//! (`apps/web/src/cloud/cloud-performer.ts`) through the wasm
//! `reconcileSubscriptions()` binding.
//!
//! Each host still owns the *diff against its own live set* and the broker I/O —
//! those are irreducibly per-platform (`mqtt-endpoint-tokio` vs `mqtt.js`) and
//! operate on host-local state, so they are not policy this module centralizes.

use crate::design_bridge as protocol;
use crate::runtime::wiring::SubscriberWiring;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use ts_rs::TS;

/// Which callback shape a subscription drives — the routing identity a broker's
/// single per-topic callback carries. Serializes to the `plain`/`topicAware`/
/// `displayEcho` strings both hosts use on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub enum SubKind {
    /// Payload-only delivery routed to a node.
    Plain,
    /// (topic, payload) delivery routed to a node (Figma).
    TopicAware,
    /// Payload echoed to the frontend only — no per-node routing.
    DisplayEcho,
}

impl SubKind {
    /// The kind a wiring resolves to.
    #[must_use]
    pub fn of(wiring: &SubscriberWiring) -> Self {
        match wiring {
            SubscriberWiring::Plain { .. } => SubKind::Plain,
            SubscriberWiring::TopicAware { .. } => SubKind::TopicAware,
            SubscriberWiring::DisplayEcho { .. } => SubKind::DisplayEcho,
        }
    }

    #[must_use]
    fn is_echo(self) -> bool {
        matches!(self, SubKind::DisplayEcho)
    }
}

/// One reconciled subscription: exactly one per `(broker_id, topic)`. Carries the
/// winning node id + kind so a host can tell when a topic's *owner* changed (and
/// must be re-subscribed) versus left untouched. Serializes to the
/// `{ brokerId, topic, nodeId, kind }` shape the browser host consumes via the
/// wasm `reconcileSubscriptions()` binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct DesiredSub {
    pub broker_id: String,
    pub topic: String,
    pub node_id: String,
    pub kind: SubKind,
}

impl DesiredSub {
    /// Deterministic winner when several nodes resolve to the same
    /// `(broker, topic)`. Routing kinds (`Plain`/`TopicAware`) beat `DisplayEcho`
    /// so a display-only echo never shadows node delivery; ties break on the
    /// lower node id. Determinism (not `HashMap` iteration order) is what keeps
    /// the desired set stable across `update_flow`s, so an unchanged flow
    /// reconciles to *zero* broker traffic.
    #[must_use]
    fn beats(&self, other: &DesiredSub) -> bool {
        match (self.kind.is_echo(), other.kind.is_echo()) {
            (false, true) => true,
            (true, false) => false,
            _ => self.node_id < other.node_id,
        }
    }
}

/// Collapse raw `(node_id, wiring)` pairs to one [`DesiredSub`] per
/// `(broker_id, topic)`, choosing the [`DesiredSub::beats`] winner on collisions.
/// The result is sorted by `(broker_id, topic)`, so it is deterministic across
/// calls regardless of input order — both hosts derive the identical desired set
/// and an unchanged flow diffs to nothing.
#[must_use]
pub fn reconcile_desired(wirings: &[(String, SubscriberWiring)]) -> Vec<DesiredSub> {
    let mut desired: HashMap<(&str, &str), DesiredSub> = HashMap::new();
    for (node_id, wiring) in wirings {
        let candidate = DesiredSub {
            broker_id: wiring.broker_id().to_string(),
            topic: wiring.topic().to_string(),
            node_id: node_id.clone(),
            kind: SubKind::of(wiring),
        };
        let key = (wiring.broker_id(), wiring.topic());
        let wins = match desired.get(&key) {
            Some(current) => candidate.beats(current),
            None => true,
        };
        if wins {
            desired.insert(key, candidate);
        }
    }
    let mut out: Vec<DesiredSub> = desired.into_values().collect();
    out.sort_by(|a, b| (&a.broker_id, &a.topic).cmp(&(&b.broker_id, &b.topic)));
    out
}

/// One Figma plugin-handshake publish a host must make over MQTT when the set of
/// live Figma plugin uids changes. The handshake **protocol** — topic shape,
/// payloads, retain flags — lives here once; the host owns only the publish I/O.
/// Previously this lived in two languages (browser `flow-reactor.ts`
/// `figmaLifecycle`, desktop `flow_update` tail), kept in lockstep by a comment.
/// Serializes to `{ brokerId, topic, payload, retain }` for the browser host
/// (via the wasm `figmaAnnounceActions` binding); the desktop host consumes the
/// struct directly. See [`figma_announce_actions`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct FigmaPublish {
    pub broker_id: String,
    pub topic: String,
    pub payload: String,
    pub retain: bool,
}

/// The Figma plugin-handshake publishes when the live plugin-uid set moves from
/// `prev` to `next` (each a `uid -> broker_id` map the host extracts from its
/// reconciled subscriptions). A uid that left a broker announces `disconnected`
/// there; a uid that arrived on a broker announces `connected` (retained)
/// **and** requests its current variable values there. A uid whose broker
/// changed did both: it left the old broker and arrived on the new one. Pure
/// policy over the uid delta — the symmetric counterpart of
/// [`reconcile_desired`] for the Figma side — so both hosts emit byte-identical
/// publishes from one source instead of mirroring the protocol.
///
/// Every departure comes before every arrival. Two broker ids can name one
/// server, where the two status publishes of a move land on the same retained
/// topic: the later one has to be `connected`, for a Studio that is still
/// there. `BTreeMap` ordering makes the rest of the order deterministic (and so
/// testable).
#[must_use]
pub fn figma_announce_actions(
    prev: &BTreeMap<String, String>,
    next: &BTreeMap<String, String>,
) -> Vec<FigmaPublish> {
    let status_topic = |uid: &str| protocol::status_topic(uid, protocol::STUDIO);
    let mut out = Vec::new();
    // Left its broker (vanished, or is on another one now) → disconnected (retained).
    for (uid, broker) in prev {
        if next.get(uid) != Some(broker) {
            out.push(FigmaPublish {
                broker_id: broker.clone(),
                topic: status_topic(uid),
                payload: "disconnected".to_string(),
                retain: true,
            });
        }
    }
    // Arrived on its broker (new, or from another one) → connected (retained)
    // + a variable-values request.
    for (uid, broker) in next {
        if prev.get(uid) == Some(broker) {
            continue;
        }
        out.push(FigmaPublish {
            broker_id: broker.clone(),
            topic: status_topic(uid),
            payload: "connected".to_string(),
            retain: true,
        });
        out.push(FigmaPublish {
            broker_id: broker.clone(),
            topic: protocol::request_topic(uid),
            payload: String::new(),
            retain: false,
        });
    }
    out
}

/// The design-bridge uid a topic belongs to, or `None` for any other topic.
/// Both hosts key the [`figma_announce_actions`] lifecycle on it, so a generic
/// Mqtt node's `microflow/…` topic never triggers a handshake. The browser
/// applies the same rule through `@microflow/design-bridge`'s `bridgeUid`.
#[must_use]
pub fn bridge_uid(topic: &str) -> Option<&str> {
    protocol::bridge_uid(topic)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wiring(node: &str, kind: SubKind, broker: &str, topic: &str) -> (String, SubscriberWiring) {
        let broker_id = broker.to_string();
        let topic = topic.to_string();
        let w = match kind {
            SubKind::Plain => SubscriberWiring::Plain { broker_id, topic },
            SubKind::TopicAware => SubscriberWiring::TopicAware { broker_id, topic },
            SubKind::DisplayEcho => SubscriberWiring::DisplayEcho { broker_id, topic },
        };
        (node.to_string(), w)
    }

    fn find<'a>(subs: &'a [DesiredSub], broker: &str, topic: &str) -> &'a DesiredSub {
        subs.iter()
            .find(|s| s.broker_id == broker && s.topic == topic)
            .expect("a desired sub for that (broker, topic)")
    }

    #[test]
    fn routing_kind_beats_display_echo_on_same_topic() {
        // A display-only echo must never shadow a routing wiring on the same topic.
        let desired = reconcile_desired(&[
            wiring("zEcho", SubKind::DisplayEcho, "b", "t"),
            wiring("aRoute", SubKind::TopicAware, "b", "t"),
        ]);
        assert_eq!(desired.len(), 1);
        let s = find(&desired, "b", "t");
        assert_eq!(s.node_id, "aRoute");
        assert_eq!(s.kind, SubKind::TopicAware);
    }

    #[test]
    fn ties_break_on_lower_node_id() {
        let desired = reconcile_desired(&[
            wiring("n2", SubKind::Plain, "b", "t"),
            wiring("n1", SubKind::Plain, "b", "t"),
        ]);
        assert_eq!(find(&desired, "b", "t").node_id, "n1");
    }

    #[test]
    fn distinct_topics_are_each_kept() {
        let desired = reconcile_desired(&[
            wiring("n1", SubKind::Plain, "b", "t1"),
            wiring("n1", SubKind::Plain, "b", "t2"),
        ]);
        assert_eq!(desired.len(), 2);
    }

    #[test]
    fn reconcile_is_deterministic_regardless_of_input_order() {
        // The whole point of the tie-break: input order (which is `HashMap`
        // iteration order at the call site) must not change the winner, or an
        // unchanged flow would churn broker subscriptions.
        let a = reconcile_desired(&[
            wiring("n2", SubKind::Plain, "b", "t"),
            wiring("n1", SubKind::Plain, "b", "t"),
        ]);
        let b = reconcile_desired(&[
            wiring("n1", SubKind::Plain, "b", "t"),
            wiring("n2", SubKind::Plain, "b", "t"),
        ]);
        assert_eq!(a, b);
    }

    #[test]
    fn serializes_to_the_host_wire_shape() {
        let desired = reconcile_desired(&[wiring("n1", SubKind::TopicAware, "b", "t")]);
        let json = serde_json::to_string(&desired).expect("serialize");
        assert!(json.contains("\"brokerId\":\"b\""), "{json}");
        assert!(json.contains("\"nodeId\":\"n1\""), "{json}");
        assert!(json.contains("\"kind\":\"topicAware\""), "{json}");
    }

    fn uids(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(u, b)| ((*u).to_string(), (*b).to_string())).collect()
    }

    fn status(broker: &str, uid: &str, payload: &str) -> FigmaPublish {
        FigmaPublish {
            broker_id: broker.into(),
            topic: format!("microflow/{uid}/app/status"),
            payload: payload.into(),
            retain: true,
        }
    }

    fn request(broker: &str, uid: &str) -> FigmaPublish {
        FigmaPublish {
            broker_id: broker.into(),
            topic: format!("microflow/{uid}/app/variables/request"),
            payload: String::new(),
            retain: false,
        }
    }

    #[test]
    fn appeared_uid_announces_connected_and_requests_variables() {
        let actions = figma_announce_actions(&uids(&[]), &uids(&[("u1", "b")]));
        assert_eq!(actions, vec![status("b", "u1", "connected"), request("b", "u1")]);
    }

    #[test]
    fn vanished_uid_announces_disconnected_retained() {
        let actions = figma_announce_actions(&uids(&[("u1", "b")]), &uids(&[]));
        assert_eq!(actions, vec![status("b", "u1", "disconnected")]);
    }

    #[test]
    fn unchanged_uid_set_announces_nothing() {
        let set = uids(&[("u1", "b"), ("u2", "b2")]);
        assert!(figma_announce_actions(&set, &set).is_empty(), "{:?}", figma_announce_actions(&set, &set));
    }

    #[test]
    fn a_uid_that_moves_to_another_broker_leaves_the_old_one_and_arrives_on_the_new_one() {
        let actions = figma_announce_actions(&uids(&[("u1", "b2")]), &uids(&[("u1", "b1")]));
        assert_eq!(
            actions,
            vec![status("b2", "u1", "disconnected"), status("b1", "u1", "connected"), request("b1", "u1")],
            "the old broker must not keep a retained `connected`, and the new one must be told",
        );
    }

    #[test]
    fn every_departure_precedes_every_arrival() {
        // u1 moves, u2 vanishes, u3 appears, u4 stays. The two broker ids of a
        // move may name one server, where both publishes land on one retained
        // status topic: `connected` must be the one that is left there.
        let prev = uids(&[("u1", "b2"), ("u2", "b1"), ("u4", "b1")]);
        let next = uids(&[("u1", "b1"), ("u3", "b2"), ("u4", "b1")]);
        assert_eq!(
            figma_announce_actions(&prev, &next),
            vec![
                status("b2", "u1", "disconnected"),
                status("b1", "u2", "disconnected"),
                status("b1", "u1", "connected"),
                request("b1", "u1"),
                status("b2", "u3", "connected"),
                request("b2", "u3"),
            ],
        );
    }
}
