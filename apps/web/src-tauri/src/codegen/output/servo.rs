//! Servo emitter — mirrors `runtime/output/servo.rs`.
//!
//! The live Servo uses the Firmata SERVO pin mode and centers itself to the
//! midpoint of its `[min, max]` range on initialize. The generated sketch uses
//! the Arduino `Servo` library: it `#include <Servo.h>`, declares a `Servo`
//! object, `attach`es it to the pin in `setup()`, and `write`s the center
//! position — matching the runtime's centering behavior. The `#include` and
//! object are only present because a Servo Node exists (the assembler
//! de-duplicates the include).

use crate::codegen::emit::{pin_or_default, u16_or_default, NodeEmission, NodeToken};
use crate::runtime::types::FlowNode;

/// Default pin matches `runtime/output/servo.rs::default_pin` (3).
const DEFAULT_PIN: u8 = 3;
/// Range defaults match `runtime/output/servo.rs` (0..=180).
const DEFAULT_MIN: u16 = 0;
const DEFAULT_MAX: u16 = 180;

/// Read the servo's `[min, max]` range from `data.range`, with runtime defaults.
fn range(node: &FlowNode) -> (u16, u16) {
    let range = node.data.get("range");
    let read = |key: &str, default: u16| {
        range
            .and_then(|r| r.get(key))
            .and_then(serde_json::Value::as_u64)
            .and_then(|n| u16::try_from(n).ok())
            .unwrap_or(default)
    };
    // Fall back to top-level keys too, then defaults.
    let min = read("min", u16_or_default(node, "min", DEFAULT_MIN));
    let max = read("max", u16_or_default(node, "max", DEFAULT_MAX));
    (min, max)
}

/// Emit C++ for a Servo Node. `driver` is the C++ integer angle expression to
/// write each loop, or `None` for an unconnected Servo which holds its center.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let pin = pin_or_default(node, DEFAULT_PIN);
    let token = node.id_token();
    let obj = format!("servo_{token}");
    let pin_var = format!("servo_{token}_pin");
    let (min, max) = range(node);
    let center = (min + max) / 2;

    let mut e = NodeEmission {
        includes: vec!["#include <Servo.h>".to_string()],
        declarations: vec![
            format!("const uint8_t {pin_var} = {pin};"),
            format!("Servo {obj};"),
        ],
        setup: vec![
            format!("{obj}.attach({pin_var});"),
            // Mirror runtime initialize: center the servo.
            format!("{obj}.write({center});"),
        ],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        e.loop_body
            .push(format!("{obj}.write(constrain((int)({expr}), {min}, {max}));"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn servo(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Servo".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    /// Scenario: A Servo Node pulls in its supporting library.
    #[test]
    fn servo_includes_library_and_declares_object() {
        let e = emit(&servo("srv-1", json!({ "pin": 9 })), None);
        assert!(e.includes.iter().any(|i| i.contains("Servo.h")), "missing Servo.h include");
        assert!(e.declarations.iter().any(|d| d.contains("Servo servo_srv_1")), "missing Servo object");
    }

    /// Scenario: A Servo Node pulls in its supporting library — attaches to pin.
    #[test]
    fn servo_attaches_to_its_pin() {
        let e = emit(&servo("srv-1", json!({ "pin": 9 })), None);
        assert!(e.declarations.iter().any(|d| d.contains("= 9;")));
        assert!(e.setup.iter().any(|s| s.contains(".attach(")), "missing attach call");
    }

    #[test]
    fn servo_centers_within_range() {
        let e = emit(&servo("srv-1", json!({ "pin": 9, "range": { "min": 0, "max": 180 } })), None);
        assert!(e.setup.iter().any(|s| s.contains(".write(90)")), "should center to 90");
    }

    #[test]
    fn servo_emits_deterministically() {
        let n = servo("srv-1", json!({ "pin": 9 }));
        assert_eq!(emit(&n, None), emit(&n, None));
    }
}
