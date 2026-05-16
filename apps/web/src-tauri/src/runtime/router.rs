//! Flow Router
//!
//! Plans the dispatch calls produced by one outgoing `ComponentEvent`.
//! Owns the (source, source_handle) → target index plus the per-target
//! delivery decision (direct value vs aggregating snapshot).
//!
//! `FlowExecutor` reduces to: gate stale events, branch internal/hardware
//! callbacks, echo `set_value` on the source, then ask the router for the
//! list of `DispatchCall`s and invoke each one.
//!
//! See `CONTEXT.md` § FlowRouter and `docs/adr/0002-flow-router-seam.md`.

use super::base::{ComponentEvent, ComponentValue};
use super::types::FlowEdge;
use rustc_hash::{FxHashMap, FxHasher};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// Target information for an edge, pre-`Arc`'d for cheap clone during fanout.
#[derive(Clone, Debug)]
pub struct EdgeTarget {
    pub target_id: Arc<str>,
    pub target_handle: Arc<str>,
    /// Edge identifier for tracking (reserved for future use)
    #[allow(dead_code)]
    pub edge_id: Option<Arc<str>>,
}

/// A planned call to one target component's `dispatch`.
///
/// The executor consumes these and invokes
/// `components.get_mut(target_id).dispatch(&target_handle, args)`.
#[derive(Clone, Debug)]
pub struct DispatchCall {
    pub target_id: Arc<str>,
    pub target_handle: Arc<str>,
    pub args: ComponentValue,
}

/// Read-only view of the component map needed for routing decisions.
///
/// The router consults this to:
/// 1. ask whether a target wants snapshot delivery (`aggregates`), and
/// 2. read sibling source values when building the snapshot (`value_of`).
///
/// Scoped intentionally narrow so the router has no opinion about how
/// components are stored. Tests pass a mock implementation backed by a
/// `HashMap<String, (bool, ComponentValue)>` and never instantiate real
/// Components.
pub trait ComponentLookup {
    /// True if the target wants snapshot delivery (`Array` of all current
    /// input values on that handle) instead of single-value delivery.
    fn aggregates(&self, id: &str) -> bool;

    /// Current stored value of a component. `None` if the component is
    /// missing — callers treat that as "skip this input."
    fn value_of(&self, id: &str) -> Option<ComponentValue>;
}

/// Pre-hashed `(source, source_handle)` → `Vec<EdgeTarget>` lookup.
///
/// Private to this module — `FxHasher` of the two strings (with a 0-byte
/// separator to avoid `("ab","c")` vs `("a","bc")` collisions) gives an
/// integer key cached in the map, so the hot path skips string hashing.
struct EdgeMap {
    map: FxHashMap<u64, Vec<EdgeTarget>>,
}

impl EdgeMap {
    fn new() -> Self {
        Self { map: FxHashMap::default() }
    }

    #[inline]
    fn key(source: &str, handle: &str) -> u64 {
        let mut hasher = FxHasher::default();
        source.hash(&mut hasher);
        0u8.hash(&mut hasher);
        handle.hash(&mut hasher);
        hasher.finish()
    }

    fn insert(&mut self, source: &str, handle: &str, target: EdgeTarget) {
        let key = Self::key(source, handle);
        self.map.entry(key).or_default().push(target);
    }

    #[inline]
    fn get(&self, source: &str, handle: &str) -> Option<&[EdgeTarget]> {
        let key = Self::key(source, handle);
        self.map.get(&key).map(std::vec::Vec::as_slice)
    }

    fn clear(&mut self) {
        self.map.clear();
    }
}

/// Plans dispatch calls for a flow graph.
pub struct FlowRouter {
    edges: Vec<FlowEdge>,
    edge_map: EdgeMap,
}

impl FlowRouter {
    #[must_use]
    pub fn new() -> Self {
        Self {
            edges: Vec::new(),
            edge_map: EdgeMap::new(),
        }
    }

    /// Replace the edge set and rebuild the lookup index. Cheap — one
    /// hashmap rebuild over the edge list.
    pub fn set_edges(&mut self, edges: Vec<FlowEdge>) {
        log::info!("Setting {} edges", edges.len());
        for edge in &edges {
            log::debug!(
                "  Edge: {} ({}) -> {} ({})",
                edge.source, edge.source_handle, edge.target, edge.target_handle
            );
        }
        self.edges = edges;
        self.rebuild_index();
    }

    /// Drop all edges and clear the lookup index.
    pub fn clear(&mut self) {
        self.edges.clear();
        self.edge_map.clear();
    }

    /// Plan the dispatch calls produced by one outgoing event.
    ///
    /// Returns an empty `Vec` when no edge originates at
    /// `(event.source, event.source_handle)`.
    ///
    /// Delivery shape per target:
    /// - **Direct** when `lookup.aggregates(target_id)` is false — pass
    ///   `event.value` straight through (one clone).
    /// - **Snapshot** when `lookup.aggregates(target_id)` is true — collect
    ///   `lookup.value_of(source)` for every edge feeding the same
    ///   `(target_id, target_handle)` and wrap as `ComponentValue::Array`.
    ///   The just-emitted source must already have been `set_value`'d by
    ///   the caller, or the snapshot will see a stale value for it.
    #[must_use]
    pub fn route(
        &self,
        event: &ComponentEvent,
        lookup: &dyn ComponentLookup,
    ) -> Vec<DispatchCall> {
        let Some(targets) = self.edge_map.get(event.source.as_ref(), event.source_handle.as_ref())
        else {
            return Vec::new();
        };

        log::trace!(
            "Found {} target(s) for {} ({})",
            targets.len(), event.source, event.source_handle
        );

        targets
            .iter()
            .map(|target| {
                let args = if lookup.aggregates(target.target_id.as_ref()) {
                    self.deliver_snapshot(target, lookup)
                } else {
                    Self::deliver_direct(&event.value)
                };
                DispatchCall {
                    target_id: target.target_id.clone(),
                    target_handle: target.target_handle.clone(),
                    args,
                }
            })
            .collect()
    }

    /// Snapshot every source feeding `(target_id, target_handle)` and
    /// return their current stored values as `Array`. Walks `edges`
    /// linearly — fanout-in counts are tiny in practice.
    fn deliver_snapshot(
        &self,
        target: &EdgeTarget,
        lookup: &dyn ComponentLookup,
    ) -> ComponentValue {
        let inputs: Vec<ComponentValue> = self
            .edges
            .iter()
            .filter(|e| {
                e.target.as_str() == target.target_id.as_ref()
                    && e.target_handle.as_str() == target.target_handle.as_ref()
            })
            .filter_map(|e| lookup.value_of(&e.source))
            .collect();
        ComponentValue::Array(inputs)
    }

    fn deliver_direct(value: &ComponentValue) -> ComponentValue {
        value.clone()
    }

    fn rebuild_index(&mut self) {
        self.edge_map.clear();
        for edge in &self.edges {
            let target = EdgeTarget {
                target_id: Arc::from(edge.target.as_str()),
                target_handle: Arc::from(edge.target_handle.as_str()),
                edge_id: edge.id.as_ref().map(|s| Arc::from(s.as_str())),
            };
            self.edge_map.insert(&edge.source, &edge.source_handle, target);
        }
    }
}

impl Default for FlowRouter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Stand-in for the executor's component map. Tests never instantiate
    /// real `Component` impls — they describe a graph of `(aggregates, value)`
    /// pairs and assert the routed `DispatchCall`s.
    struct MockLookup {
        flags: HashMap<String, (bool, ComponentValue)>,
    }

    impl MockLookup {
        fn new() -> Self {
            Self { flags: HashMap::new() }
        }

        fn with(mut self, id: &str, aggregates: bool, value: ComponentValue) -> Self {
            self.flags.insert(id.to_string(), (aggregates, value));
            self
        }
    }

    impl ComponentLookup for MockLookup {
        fn aggregates(&self, id: &str) -> bool {
            self.flags.get(id).is_some_and(|(a, _)| *a)
        }

        fn value_of(&self, id: &str) -> Option<ComponentValue> {
            self.flags.get(id).map(|(_, v)| v.clone())
        }
    }

    fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> FlowEdge {
        FlowEdge {
            id: None,
            source: source.to_string(),
            source_handle: source_handle.to_string(),
            target: target.to_string(),
            target_handle: target_handle.to_string(),
        }
    }

    fn event(source: &str, handle: &str, value: ComponentValue) -> ComponentEvent {
        ComponentEvent {
            source: Arc::from(source),
            source_handle: Arc::from(handle),
            value,
            edge_id: None,
            sequence: 0,
        }
    }

    #[test]
    fn no_targets_yields_empty_plan() {
        let router = FlowRouter::new();
        let lookup = MockLookup::new();
        let plan = router.route(
            &event("nobody", "value", ComponentValue::Number(1.0)),
            &lookup,
        );
        assert!(plan.is_empty());
    }

    #[test]
    fn direct_delivery_passes_value_through() {
        let mut router = FlowRouter::new();
        router.set_edges(vec![edge("btn", "event", "led", "value")]);
        let lookup = MockLookup::new().with("led", false, ComponentValue::Bool(false));

        let plan = router.route(
            &event("btn", "event", ComponentValue::Bool(true)),
            &lookup,
        );

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].target_id.as_ref(), "led");
        assert_eq!(plan[0].target_handle.as_ref(), "value");
        assert_eq!(plan[0].args, ComponentValue::Bool(true));
    }

    #[test]
    fn fanout_creates_one_call_per_target() {
        let mut router = FlowRouter::new();
        router.set_edges(vec![
            edge("btn", "event", "led1", "value"),
            edge("btn", "event", "led2", "value"),
        ]);
        let lookup = MockLookup::new()
            .with("led1", false, ComponentValue::Bool(false))
            .with("led2", false, ComponentValue::Bool(false));

        let plan = router.route(
            &event("btn", "event", ComponentValue::Bool(true)),
            &lookup,
        );

        assert_eq!(plan.len(), 2);
        assert!(plan.iter().any(|c| c.target_id.as_ref() == "led1"));
        assert!(plan.iter().any(|c| c.target_id.as_ref() == "led2"));
    }

    #[test]
    fn aggregating_target_gets_snapshot_array() {
        let mut router = FlowRouter::new();
        router.set_edges(vec![
            edge("em1", "value", "calc", "value"),
            edge("em2", "value", "calc", "value"),
        ]);
        let lookup = MockLookup::new()
            .with("em1", false, ComponentValue::Number(100.0))
            .with("em2", false, ComponentValue::Number(50.0))
            .with("calc", true, ComponentValue::Number(0.0));

        let plan = router.route(
            &event("em1", "value", ComponentValue::Number(100.0)),
            &lookup,
        );

        assert_eq!(plan.len(), 1);
        match &plan[0].args {
            ComponentValue::Array(items) => {
                assert_eq!(items.len(), 2);
                assert!(items.contains(&ComponentValue::Number(100.0)));
                assert!(items.contains(&ComponentValue::Number(50.0)));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn snapshot_only_includes_edges_for_matching_handle() {
        let mut router = FlowRouter::new();
        router.set_edges(vec![
            edge("a", "value", "calc", "value"),
            edge("b", "value", "calc", "other"),
        ]);
        let lookup = MockLookup::new()
            .with("a", false, ComponentValue::Number(1.0))
            .with("b", false, ComponentValue::Number(2.0))
            .with("calc", true, ComponentValue::Number(0.0));

        let plan = router.route(
            &event("a", "value", ComponentValue::Number(1.0)),
            &lookup,
        );

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].target_handle.as_ref(), "value");
        match &plan[0].args {
            ComponentValue::Array(items) => {
                assert_eq!(items.len(), 1, "only the 'value' handle should contribute");
                assert_eq!(items[0], ComponentValue::Number(1.0));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn clear_removes_all_targets() {
        let mut router = FlowRouter::new();
        router.set_edges(vec![edge("a", "out", "b", "in")]);
        router.clear();

        let plan = router.route(
            &event("a", "out", ComponentValue::Number(1.0)),
            &MockLookup::new(),
        );
        assert!(plan.is_empty());
    }

    #[test]
    fn set_edges_replaces_previous_set() {
        let mut router = FlowRouter::new();
        router.set_edges(vec![edge("a", "out", "old", "in")]);
        router.set_edges(vec![edge("a", "out", "new", "in")]);

        let plan = router.route(
            &event("a", "out", ComponentValue::Number(1.0)),
            &MockLookup::new().with("new", false, ComponentValue::Number(0.0)),
        );
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].target_id.as_ref(), "new");
    }
}
