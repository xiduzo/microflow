//! Shared emitter contract for per-Node C++ emission.
//!
//! Each supported core hardware-IO Node contributes C++ fragments into the
//! sketch regions produced by the skeleton (Task 1): the include block, the
//! global declarations region, `setup()`, and `loop()`. An emitter is a pure
//! function of a single [`FlowNode`] — it reads the Node's `data` field (the
//! same `data` the live runtime deserializes into its `*Config`) and returns a
//! [`NodeEmission`]. No clock, no hashmap iteration, no board IO: identical
//! input always yields identical output.

use crate::runtime::types::FlowNode;

/// C++ fragments a single Node contributes to the assembled sketch.
///
/// Every field is optional in spirit — an emitter only fills the regions it
/// needs. `mod.rs` concatenates these across all Nodes in deterministic
/// traversal order.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NodeEmission {
    /// Lines for the top-of-file include block (e.g. `#include <Servo.h>`).
    /// De-duplicated by the assembler so repeated Node types include once.
    pub includes: Vec<String>,
    /// Global declaration lines (e.g. `const uint8_t led_13_pin = 13;`).
    pub declarations: Vec<String>,
    /// Statements emitted inside `setup()` (e.g. `pinMode(...)`).
    pub setup: Vec<String>,
    /// Statements emitted inside `loop()` (read/write logic).
    pub loop_body: Vec<String>,
}

impl NodeEmission {
    /// True when the Node produced no C++ at all (unsupported / skipped).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.includes.is_empty()
            && self.declarations.is_empty()
            && self.setup.is_empty()
            && self.loop_body.is_empty()
    }
}

/// Extension methods for turning Flow read-model types into C++-safe tokens.
pub trait NodeToken {
    /// A C++-identifier-safe token derived from the Node `id`. Flow ids may
    /// contain hyphens or other punctuation (e.g. `led-1`); every non
    /// alphanumeric character is replaced with `_` so the token can be used in
    /// variable names. Deterministic for a given id.
    fn id_token(&self) -> String;
}

impl NodeToken for FlowNode {
    fn id_token(&self) -> String {
        self.id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    }
}

/// Read a pin from a Node's `data`, accepting either a JSON number (`13`) or a
/// numeric/`"A0"`-style string, mirroring the live runtime's lenient pin
/// deserialization. Returns `default` when the field is missing or unparseable
/// so emission never produces uncompilable code for a malformed Node.
#[must_use]
pub fn pin_or_default(node: &FlowNode, default: u8) -> u8 {
    let Some(value) = node.data.get("pin") else {
        return default;
    };
    if let Some(n) = value.as_u64() {
        return u8::try_from(n).unwrap_or(default);
    }
    if let Some(s) = value.as_str() {
        let digits = s.strip_prefix(['A', 'a']).unwrap_or(s);
        return digits.parse().unwrap_or(default);
    }
    default
}

/// Read a boolean flag from a Node's `data`, defaulting to `false`.
#[must_use]
pub fn bool_flag(node: &FlowNode, key: &str) -> bool {
    node.data.get(key).and_then(serde_json::Value::as_bool).unwrap_or(false)
}

/// Read a `u16` from a Node's `data`, falling back to `default`.
#[must_use]
pub fn u16_or_default(node: &FlowNode, key: &str, default: u16) -> u16 {
    node.data
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u16::try_from(n).ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn node_with(data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: "n".to_string(),
            node_type: Some("Led".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn pin_reads_numeric_value() {
        assert_eq!(pin_or_default(&node_with(json!({ "pin": 9 })), 13), 9);
    }

    #[test]
    fn pin_reads_string_value() {
        assert_eq!(pin_or_default(&node_with(json!({ "pin": "14" })), 0), 14);
    }

    #[test]
    fn pin_reads_legacy_analog_string() {
        assert_eq!(pin_or_default(&node_with(json!({ "pin": "A0" })), 99), 0);
    }

    #[test]
    fn pin_falls_back_when_missing_or_invalid() {
        assert_eq!(pin_or_default(&node_with(json!({})), 13), 13);
        assert_eq!(pin_or_default(&node_with(json!({ "pin": "xyz" })), 7), 7);
    }

    #[test]
    fn id_token_sanitizes_punctuation() {
        let n = node_with(json!({}));
        let mut hyphenated = n.clone();
        hyphenated.id = "led-1".to_string();
        assert_eq!(hyphenated.id_token(), "led_1");
    }

    #[test]
    fn empty_emission_is_empty() {
        assert!(NodeEmission::default().is_empty());
    }
}
