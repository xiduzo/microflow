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
//! The executor therefore stops a turn after [`TURN_BUDGET`] drained events and
//! drops the rest of the queue. What it does next depends on why the turn ran
//! long, which [`loop_members`] decides from the flow's edges:
//!
//! - **A loop** — the turn's last emitters sit on a cycle. Every node of that
//!   cycle (its whole strongly connected component, not just the part the
//!   last events happened to touch) is paused, so the next stimulus does not
//!   burn another full budget, until a flow update reshapes it.
//! - **No loop** — an acyclic flow whose events multiply (aggregating Gates in
//!   a chain of diamonds double per level). Nothing is paused: the node where
//!   the budget ran out is warned, and the next flow update clears the warning.

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

/// How many of the last events before the budget runs out are traced. Their
/// emitters only *seed* the loop search — the loop itself comes from the edge
/// graph — so this need not cover a whole loop, just reach into one.
pub(crate) const TRACE_TAIL: u32 = 256;

/// The nodes of every cycle in `edges` that contains one of the `tail`
/// emitters: the union of the non-trivial strongly connected components (two
/// or more nodes, or one with a self-edge) they belong to. Sorted. Empty when
/// none of them is on a cycle — the turn ran long without a loop.
#[must_use]
pub(crate) fn loop_members(tail: &HashSet<Arc<str>>, edges: &[FlowEdge]) -> Vec<Arc<str>> {
    let graph = Graph::new(edges);
    let component = graph.strongly_connected_components();
    let mut size = vec![0usize; graph.names.len()];
    for &c in &component {
        size[c] += 1;
    }
    let looping = |node: usize| size[component[node]] > 1 || graph.self_loop[node];

    let seeds: HashSet<usize> = tail
        .iter()
        .filter_map(|name| graph.index.get(name.as_ref()).copied())
        .filter(|&node| looping(node))
        .map(|node| component[node])
        .collect();
    let mut members: Vec<Arc<str>> = (0..graph.names.len())
        .filter(|&node| seeds.contains(&component[node]))
        .map(|node| Arc::from(graph.names[node]))
        .collect();
    members.sort();
    members
}

/// The edges with either end in `nodes`, as comparable tuples — the wiring of
/// a paused loop and everything plugged into it. A flow update that leaves this
/// unchanged (and rebuilds none of the nodes) leaves the loop exactly as
/// runaway as it was; any other change to it releases the loop to be judged
/// again.
#[must_use]
pub(crate) fn edges_touching(nodes: &HashSet<Arc<str>>, edges: &[FlowEdge]) -> Vec<[String; 4]> {
    let mut within: Vec<[String; 4]> = edges
        .iter()
        .filter(|e| nodes.contains(e.source.as_str()) || nodes.contains(e.target.as_str()))
        .map(|e| {
            [e.source.clone(), e.source_handle.clone(), e.target.clone(), e.target_handle.clone()]
        })
        .collect();
    within.sort();
    within
}

/// The node graph of an edge list, indexed for the component search.
struct Graph<'a> {
    names: Vec<&'a str>,
    index: HashMap<&'a str, usize>,
    next: Vec<Vec<usize>>,
    prev: Vec<Vec<usize>>,
    self_loop: Vec<bool>,
}

impl<'a> Graph<'a> {
    fn new(edges: &'a [FlowEdge]) -> Self {
        let mut graph = Self {
            names: Vec::new(),
            index: HashMap::new(),
            next: Vec::new(),
            prev: Vec::new(),
            self_loop: Vec::new(),
        };
        for edge in edges {
            let source = graph.node(&edge.source);
            let target = graph.node(&edge.target);
            if source == target {
                graph.self_loop[source] = true;
            }
            graph.next[source].push(target);
            graph.prev[target].push(source);
        }
        graph
    }

    fn node(&mut self, name: &'a str) -> usize {
        if let Some(&i) = self.index.get(name) {
            return i;
        }
        let i = self.names.len();
        self.names.push(name);
        self.index.insert(name, i);
        self.next.push(Vec::new());
        self.prev.push(Vec::new());
        self.self_loop.push(false);
        i
    }

    /// Kosaraju, iteratively (a flow can be deeper than the stack is safe for):
    /// finish order over `next`, then components over `prev` in reverse finish
    /// order. Returns each node's component id.
    fn strongly_connected_components(&self) -> Vec<usize> {
        let n = self.names.len();
        let mut order = Vec::with_capacity(n);
        let mut visited = vec![false; n];
        for start in 0..n {
            if visited[start] {
                continue;
            }
            visited[start] = true;
            let mut stack = vec![(start, 0usize)];
            while let Some((node, child)) = stack.pop() {
                if let Some(&next) = self.next[node].get(child) {
                    stack.push((node, child + 1));
                    if !visited[next] {
                        visited[next] = true;
                        stack.push((next, 0));
                    }
                } else {
                    order.push(node);
                }
            }
        }

        let mut component = vec![usize::MAX; n];
        let mut count = 0;
        for &root in order.iter().rev() {
            if component[root] != usize::MAX {
                continue;
            }
            component[root] = count;
            let mut stack = vec![root];
            while let Some(node) = stack.pop() {
                for &prev in &self.prev[node] {
                    if component[prev] == usize::MAX {
                        component[prev] = count;
                        stack.push(prev);
                    }
                }
            }
            count += 1;
        }
        component
    }
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

    fn tail(ids: &[&str]) -> HashSet<Arc<str>> {
        ids.iter().map(|id| Arc::from(*id)).collect()
    }

    fn names(members: &[Arc<str>]) -> Vec<&str> {
        members.iter().map(AsRef::as_ref).collect()
    }

    #[test]
    fn finds_the_ring_and_not_what_hangs_off_it() {
        // a → b → c → a is the loop; d is fed by it and also emitted (hot).
        let edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("c", "d")];
        let members = loop_members(&tail(&["a", "b", "c", "d"]), &edges);
        assert_eq!(names(&members), ["a", "b", "c"]);
    }

    #[test]
    fn the_whole_loop_from_any_one_of_its_nodes() {
        // The tail only reached `b`; the loop is still all of it, so cutting it
        // anywhere changes the paused set's edges.
        let edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("x", "a")];
        let members = loop_members(&tail(&["b"]), &edges);
        assert_eq!(names(&members), ["a", "b", "c"]);
    }

    #[test]
    fn a_self_edge_is_a_loop() {
        let members = loop_members(&tail(&["a"]), &[edge("a", "a")]);
        assert_eq!(names(&members), ["a"]);
    }

    #[test]
    fn an_acyclic_flow_has_no_loop() {
        // A diamond: a → b, a → c, b → d, c → d. Events multiply; nothing loops.
        let edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")];
        assert!(loop_members(&tail(&["a", "b", "c", "d"]), &edges).is_empty(), "{:?}", loop_members(&tail(&["a", "b", "c", "d"]), &edges));
    }

    #[test]
    fn a_loop_the_tail_never_reached_is_not_this_turns_loop() {
        let edges = [edge("a", "b"), edge("x", "y"), edge("y", "x")];
        assert!(loop_members(&tail(&["a", "b"]), &edges).is_empty(), "{:?}", loop_members(&tail(&["a", "b"]), &edges));
    }

    #[test]
    fn a_long_ring_is_found_whole() {
        let n = 5_000;
        let id = |i: usize| format!("g{i}");
        let edges: Vec<FlowEdge> = (0..n).map(|i| edge(&id(i), &id((i + 1) % n))).collect();
        assert_eq!(loop_members(&tail(&["g7"]), &edges).len(), n);
    }
}
