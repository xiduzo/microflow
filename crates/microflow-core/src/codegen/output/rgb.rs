//! Rgb emitter — mirrors `runtime/output/rgb.rs`.
//!
//! The live RGB LED drives three PWM pins (red/green/blue). It sets each pin to
//! PWM mode and turns the LED off on initialize. A common-anode (`isAnode`) LED
//! is active-low, so its channel writes are inverted (`255 - value`). The
//! generated sketch declares the three pin constants, sets them OUTPUT, writes
//! them off in `setup()`, and — when wired from a single upstream value — drives
//! all three channels with that brightness via `analogWrite`, honouring the
//! anode inversion so emitted behavior matches the runtime.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Channel pin defaults match `runtime/output/rgb.rs` (red=9, green=10, blue=11).
const DEFAULT_RED: u8 = 9;
const DEFAULT_GREEN: u8 = 10;
const DEFAULT_BLUE: u8 = 11;

/// Read a channel pin from `data.pins.<channel>` with the runtime default.
fn channel_pin(node: &FlowNode, channel: &str, default: u8) -> u8 {
    node.data
        .get("pins")
        .and_then(|p| p.get(channel))
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u8::try_from(n).ok())
        .unwrap_or(default)
}

/// True when the LED is common-anode (active-low channels).
fn is_anode(node: &FlowNode) -> bool {
    node.data.get("isAnode").and_then(serde_json::Value::as_bool).unwrap_or(false)
}

/// Emit C++ for an Rgb Node. `driver` is an optional brightness expression
/// (0..=255) applied to every channel; `None` leaves the LED off.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let red = format!("rgb_{token}_red_pin");
    let green = format!("rgb_{token}_green_pin");
    let blue = format!("rgb_{token}_blue_pin");
    let anode = is_anode(node);
    // Off level: common-anode is active-low, so "off" is 255.
    let off = if anode { 255 } else { 0 };

    let mut e = NodeEmission {
        declarations: vec![
            format!("const uint8_t {red} = {};", channel_pin(node, "red", DEFAULT_RED)),
            format!("const uint8_t {green} = {};", channel_pin(node, "green", DEFAULT_GREEN)),
            format!("const uint8_t {blue} = {};", channel_pin(node, "blue", DEFAULT_BLUE)),
        ],
        setup: vec![
            format!("pinMode({red}, OUTPUT);"),
            format!("pinMode({green}, OUTPUT);"),
            format!("pinMode({blue}, OUTPUT);"),
            // Mirror runtime initialize: start off.
            format!("analogWrite({red}, {off});"),
            format!("analogWrite({green}, {off});"),
            format!("analogWrite({blue}, {off});"),
        ],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        // Common-anode inverts the duty cycle.
        let level = if anode {
            format!("(255 - constrain((int)({expr}), 0, 255))")
        } else {
            format!("constrain((int)({expr}), 0, 255)")
        };
        e.loop_body.push(format!("analogWrite({red}, {level});"));
        e.loop_body.push(format!("analogWrite({green}, {level});"));
        e.loop_body.push(format!("analogWrite({blue}, {level});"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn rgb(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Rgb".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn rgb_sets_three_pwm_pins_and_starts_off() {
        let e = emit(&rgb("rgb-1", json!({})), None);
        assert_eq!(e.setup.iter().filter(|s| s.contains("pinMode")).count(), 3);
        assert!(e.declarations.iter().any(|d| d.contains("= 9;")));
        assert!(e.setup.iter().filter(|s| s.contains("analogWrite") && s.contains(", 0)")).count() >= 3);
    }

    #[test]
    fn rgb_drives_all_channels_from_value() {
        let e = emit(&rgb("rgb-1", json!({})), Some("sensor_x_value"));
        assert_eq!(e.loop_body.iter().filter(|l| l.contains("analogWrite") && l.contains("sensor_x_value")).count(), 3);
    }

    #[test]
    fn rgb_anode_inverts_levels() {
        let e = emit(&rgb("rgb-1", json!({ "isAnode": true })), Some("v"));
        assert!(e.loop_body.iter().any(|l| l.contains("255 -")));
        assert!(e.setup.iter().any(|s| s.contains("analogWrite") && s.contains(", 255)")));
    }

    #[test]
    fn rgb_reads_custom_pins() {
        let e = emit(&rgb("rgb-1", json!({ "pins": { "red": 3, "green": 5, "blue": 6 } })), None);
        assert!(e.declarations.iter().any(|d| d.contains("= 3;")));
        assert!(e.declarations.iter().any(|d| d.contains("= 5;")));
        assert!(e.declarations.iter().any(|d| d.contains("= 6;")));
    }

    #[test]
    fn rgb_emits_deterministically() {
        let n = rgb("rgb-1", json!({ "isAnode": true }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
