//! Placeholder emitter — the graceful fallback for Node types without a
//! registered C++ emitter.
//!
//! The codegen Node-type dispatch ([`crate::codegen::emit_node`]) routes every
//! supported core hardware-IO Node (Led, Relay, Servo, Button, Sensor) to its
//! emitter. Anything else — Cloud Nodes that cross the hardware boundary
//! (`Mqtt`, `Figma`, `Llm`, `Monitor`), Nodes with no `node_type` at all, and
//! any future/unknown type — falls through to this module instead of silently
//! emitting nothing or panicking.
//!
//! The result is a single declaration-region comment line identifying the Node
//! by id and type, with a message tailored to *why* it cannot run on the board:
//!
//! - **Cloud Nodes** need a networked target and cannot execute on a bare
//!   board, so their comment says exactly that (Epic sub-seam).
//! - **Unknown / typeless Nodes** simply have no emitter; their comment says so.
//!
//! Like every other emitter this is a pure function of the [`FlowNode`]: no
//! clock, no IO, no hashmap iteration. Identical input always yields identical
//! output, preserving the determinism invariant — the placeholder text never
//! contains timestamps or other non-deterministic data.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::runtime::types::FlowNode;

/// The Cloud Node types — those in the `external` category of
/// `apps/web/node-components.json`. They communicate with networked services
/// and cannot run on a standalone board, so they get a clearer message.
const CLOUD_NODE_TYPES: [&str; 4] = ["Mqtt", "Figma", "Llm", "Monitor"];

/// True when `node_type` names a Cloud (networked) Node.
fn is_cloud_node(node_type: &str) -> bool {
    CLOUD_NODE_TYPES.contains(&node_type)
}

/// Emit a deterministic placeholder comment for a Node that has no registered
/// emitter. Returns a [`NodeEmission`] carrying a single declaration-region
/// comment line so the Node is still visible in the sketch while contributing
/// no runnable code. Never panics, even for a `None` `node_type`.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let token = node.id_token();
    let comment = match node.node_type.as_deref() {
        Some(kind) if is_cloud_node(kind) => format!(
            "// unsupported Node {token} ({kind}): Cloud Node requires a networked target — no on-board code generated"
        ),
        Some(kind) => format!(
            "// unsupported Node {token} ({kind}): no emitter for this Node type — no code generated"
        ),
        None => format!(
            "// unsupported Node {token} (unknown): Node has no type — no code generated"
        ),
    };

    NodeEmission {
        declarations: vec![comment],
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn node(id: &str, kind: Option<&str>) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: kind.map(str::to_string),
            data: json!({}),
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    /// Scenario: An unsupported Node becomes a placeholder comment.
    /// A Cloud Node yields a placeholder identifying it and explaining it needs
    /// a networked target.
    #[test]
    fn cloud_node_emits_networked_target_placeholder() {
        let e = emit(&node("mqtt-1", Some("Mqtt")));
        assert_eq!(e.declarations.len(), 1, "exactly one comment line");
        let comment = &e.declarations[0];
        assert!(comment.starts_with("//"), "must be a comment");
        assert!(comment.contains("mqtt_1"), "identifies the Node id");
        assert!(comment.contains("Mqtt"), "identifies the Node type");
        assert!(
            comment.contains("networked target"),
            "explains it needs a networked target, got: {comment}"
        );
        // No runnable code is contributed.
        assert!(e.includes.is_empty());
        assert!(e.setup.is_empty());
        assert!(e.loop_body.is_empty());
    }

    /// All four Cloud Node types get the networked-target message.
    #[test]
    fn all_cloud_node_types_get_networked_message() {
        for kind in ["Mqtt", "Figma", "Llm", "Monitor"] {
            let e = emit(&node("c-1", Some(kind)));
            assert!(
                e.declarations[0].contains("networked target"),
                "{kind} should be treated as a Cloud Node"
            );
            assert!(e.declarations[0].contains(kind), "{kind} named in comment");
        }
    }

    /// Scenario: An unknown Node type does not break generation.
    /// A type with no emitter (and not a Cloud type) gets a generic placeholder
    /// identifying it.
    #[test]
    fn unknown_node_type_emits_generic_placeholder() {
        let e = emit(&node("widget-1", Some("Gizmo")));
        assert_eq!(e.declarations.len(), 1);
        let comment = &e.declarations[0];
        assert!(comment.contains("widget_1"), "identifies the Node id");
        assert!(comment.contains("Gizmo"), "identifies the Node type");
        assert!(comment.contains("no emitter"), "generic unsupported message");
        // Not described as a Cloud Node.
        assert!(!comment.contains("networked target"));
    }

    /// Edge case: a Node with no `node_type` must not panic and must still be
    /// identified.
    #[test]
    fn typeless_node_does_not_panic_and_is_identified() {
        let e = emit(&node("mystery-1", None));
        assert_eq!(e.declarations.len(), 1);
        let comment = &e.declarations[0];
        assert!(comment.contains("mystery_1"), "identifies the Node id");
        assert!(comment.contains("unknown"), "marked as unknown type");
    }

    /// Scenario: Placeholder comments are deterministic.
    /// The same unsupported Node yields a byte-identical placeholder every time.
    #[test]
    fn placeholder_is_deterministic() {
        let n = node("mqtt-1", Some("Mqtt"));
        let first = emit(&n);
        let second = emit(&n);
        assert_eq!(first, second, "same Node must emit identical placeholder");
    }
}
