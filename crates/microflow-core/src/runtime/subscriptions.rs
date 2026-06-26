//! Subscription reconciliation policy — shared by both **Runtime Host**s.
//!
//! A flow's subscribe nodes each return a [`SubscriberWiring`]; several can
//! resolve to the same `(broker_id, topic)`, but a broker keeps exactly one
//! callback per topic. Collapsing the wirings to one **desired** subscription per
//! topic — and picking a *deterministic* winner when they collide — is policy
//! BOTH hosts must apply identically, or the desktop and browser would disagree
//! on which node owns a topic. It previously lived in two languages (desktop
//! `commands.rs` `DesiredSub::beats`, browser `mqtt-subscriptions.ts`
//! `beats`/`reconcileDesired`), kept in lockstep only by a comment. This is the
//! single source.
//!
//! Each host still owns the *diff against its own live set* and the broker I/O —
//! those are irreducibly per-platform (`rumqttc` vs `mqtt.js`) and operate on
//! host-local state, so they are not policy this module centralizes.

use crate::runtime::wiring::SubscriberWiring;
use serde::Serialize;
use std::collections::HashMap;

/// Which callback shape a subscription drives — the routing identity a broker's
/// single per-topic callback carries. Serializes to the `plain`/`topicAware`/
/// `displayEcho` strings both hosts use on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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
}
