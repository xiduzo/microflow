//! The turn budget — the bound that makes every runtime turn end.
//!
//! A turn drains the emit queue until it is empty. Every node's `emit` always
//! fires (momentary handles must not be value-deduped, see
//! [`ComponentBase::emit`](super::ComponentBase::emit)), so a cycle of
//! pass-through nodes — two Gates wired `true → value` into each other — keeps
//! the queue non-empty forever. On a single-threaded host that hangs the
//! browser tab or the desktop actor, and because the flow is persisted and
//! shared, it hangs every collaborator who opens it.
//!
//! The executor therefore stops a turn after [`TURN_BUDGET`] drained events,
//! drops the rest of the queue, and pauses the nodes that were looping (see
//! [`loop_members`]) so the next stimulus does not burn another full budget.
//! The runtime stays alive; the paused nodes carry a node diagnostic until the
//! loop is edited.

use crate::flow::FlowEdge;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Events one turn may drain before it is stopped.
///
/// A turn is one stimulus (a serial chunk, a timer tick, an input, a flow
/// update) and the cascade it causes. In a flow without a runaway loop each
/// node emits a handful of events per stimulus — Gate and Compare fire `value`
/// plus `true`/`false`, an aggregating input re-fires once per feeding edge —
/// so a legitimate turn drains on the order of `nodes × fan-in`: tens to low
/// hundreds of events. The largest legitimate turns are a flow update (every
/// newly-built node's `on_start` and its cascade) and a serial chunk that
/// carries a backlog of I2C replies (one event per reply, a few hundred in a
/// 4 KiB chunk). Oscillator, Interval and Music emit once per *timer* turn —
/// their periodic output is spread across turns, never inside one. 10 000
/// leaves an order of magnitude of headroom over a several-hundred-node flow,
/// while a runaway loop is stopped in milliseconds (well under one frame on
/// the desktop host; a few frames in wasm).
pub const TURN_BUDGET: u32 = 10_000;

/// How many of the last events before the budget runs out are traced to find
/// the looping nodes. Must exceed any realistic loop length; recording only
/// this tail keeps the per-event cost of the budget to a counter compare.
pub(crate) const TRACE_TAIL: u32 = 256;

/// The emitters in `hot` that lie on a cycle of `edges` restricted to `hot`
/// — the nodes keeping a runaway turn alive. Sorted for determinism. Empty when
/// the hot set holds no cycle (an acyclic blow-up, or a loop longer than the
/// trace tail); the caller then falls back to the node where the budget ran
/// out.
#[must_use]
pub(crate) fn loop_members(hot: &HashSet<Arc<str>>, edges: &[FlowEdge]) -> Vec<Arc<str>> {
    let mut next: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        if hot.contains(edge.source.as_str()) && hot.contains(edge.target.as_str()) {
            next.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
        }
    }
    let mut members: Vec<Arc<str>> = hot
        .iter()
        .filter(|node| reaches_itself(node, &next))
        .cloned()
        .collect();
    members.sort();
    members
}

/// Whether `start` can reach itself through `next` (a self-edge counts).
fn reaches_itself(start: &str, next: &HashMap<&str, Vec<&str>>) -> bool {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut stack: Vec<&str> = next.get(start).cloned().unwrap_or_default();
    while let Some(node) = stack.pop() {
        if node == start {
            return true;
        }
        if seen.insert(node) {
            if let Some(targets) = next.get(node) {
                stack.extend(targets.iter().copied());
            }
        }
    }
    false
}

/// The edges whose both ends are in `nodes`, as comparable tuples — the shape
/// of a paused loop. A flow update that leaves this unchanged (and rebuilds
/// none of the nodes) leaves the loop exactly as runaway as it was.
#[must_use]
pub(crate) fn edges_within(nodes: &HashSet<Arc<str>>, edges: &[FlowEdge]) -> Vec<[String; 4]> {
    let mut within: Vec<[String; 4]> = edges
        .iter()
        .filter(|e| nodes.contains(e.source.as_str()) && nodes.contains(e.target.as_str()))
        .map(|e| {
            [e.source.clone(), e.source_handle.clone(), e.target.clone(), e.target_handle.clone()]
        })
        .collect();
    within.sort();
    within
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(source: &str, target: &str) -> FlowEdge {
        FlowEdge {
            id: None,
            source: source.to_string(),
            source_handle: "value".to_string(),
            target: target.to_string(),
            target_handle: "value".to_string(),
        }
    }

    fn hot(ids: &[&str]) -> HashSet<Arc<str>> {
        ids.iter().map(|id| Arc::from(*id)).collect()
    }

    fn names(members: &[Arc<str>]) -> Vec<&str> {
        members.iter().map(AsRef::as_ref).collect()
    }

    #[test]
    fn finds_the_ring_and_not_what_hangs_off_it() {
        // a → b → c → a is the loop; d is fed by it and also emitted (hot).
        let edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("c", "d")];
        let members = loop_members(&hot(&["a", "b", "c", "d"]), &edges);
        assert_eq!(names(&members), ["a", "b", "c"]);
    }

    #[test]
    fn a_self_edge_is_a_loop() {
        let members = loop_members(&hot(&["a"]), &[edge("a", "a")]);
        assert_eq!(names(&members), ["a"]);
    }

    #[test]
    fn an_acyclic_hot_set_has_no_members() {
        let edges = [edge("a", "b"), edge("b", "c")];
        assert!(loop_members(&hot(&["a", "b", "c"]), &edges).is_empty());
    }

    #[test]
    fn a_cycle_through_a_cold_node_is_not_this_turns_loop() {
        // a → x → a, but x never emitted this turn, so it is not what spun.
        let edges = [edge("a", "x"), edge("x", "a")];
        assert!(loop_members(&hot(&["a"]), &edges).is_empty());
    }
}
