//! Matrix emitter — mirrors `runtime/output/matrix.rs`.
//!
//! The live Matrix drives a MAX7219 LED matrix over bit-banged SPI (data, clock,
//! CS pins), initialising the chip out of shutdown, setting a scan limit and
//! intensity, and clearing the display. The generated sketch uses the standard
//! Arduino `LedControl` library, whose `LedControl(dataPin, clkPin, csPin,
//! numDevices)` wraps exactly this MAX7219 protocol: `setup()` wakes each device
//! from power-down (`shutdown(i, false)`), sets a mid intensity, and clears the
//! display — mirroring the runtime's `init_max7219` + blank-on-init. When wired
//! from an upstream signal the whole display is lit or cleared accordingly.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Pin defaults match `runtime/output/matrix.rs` (data=2, clock=3, cs=4).
const DEFAULT_DATA: u8 = 2;
const DEFAULT_CLOCK: u8 = 3;
const DEFAULT_CS: u8 = 4;
/// Device-count default matches `runtime/output/matrix.rs::default_devices` (1).
const DEFAULT_DEVICES: u8 = 1;

fn pin(node: &FlowNode, key: &str, default: u8) -> u8 {
    node.data
        .get("pins")
        .and_then(|p| p.get(key))
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u8::try_from(n).ok())
        .unwrap_or(default)
}

fn devices(node: &FlowNode) -> u8 {
    node.data
        .get("devices")
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u8::try_from(n).ok())
        .unwrap_or(DEFAULT_DEVICES)
        .max(1)
}

/// Emit C++ for a Matrix Node. `driver` is an optional boolean: when wired, a
/// true value lights every LED and a false value clears the display.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let obj = format!("matrix_{token}");
    let data = pin(node, "data", DEFAULT_DATA);
    let clock = pin(node, "clock", DEFAULT_CLOCK);
    let cs = pin(node, "cs", DEFAULT_CS);
    let devices = devices(node);
    let i = format!("matrix_{token}_i");
    let row = format!("matrix_{token}_row");

    let mut e = NodeEmission {
        includes: vec!["#include <LedControl.h>".to_string()],
        declarations: vec![format!(
            "LedControl {obj}({data}, {clock}, {cs}, {devices});"
        )],
        setup: vec![
            format!("for (int {i} = 0; {i} < {devices}; {i}++) {{"),
            // Mirror init_max7219: wake from shutdown, mid intensity, clear.
            format!("  {obj}.shutdown({i}, false);"),
            format!("  {obj}.setIntensity({i}, 8);"),
            format!("  {obj}.clearDisplay({i});"),
            "}".to_string(),
        ],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        e.loop_body.push(format!("for (int {i} = 0; {i} < {devices}; {i}++) {{"));
        e.loop_body.push(format!("  for (int {row} = 0; {row} < 8; {row}++) {{"));
        e.loop_body.push(format!(
            "    {obj}.setRow({i}, {row}, ({expr}) ? 0xFF : 0x00);"
        ));
        e.loop_body.push("  }".to_string());
        e.loop_body.push("}".to_string());
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn matrix(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Matrix".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn matrix_includes_library_and_declares_object() {
        let e = emit(&matrix("mx-1", json!({})), None);
        assert!(e.includes.iter().any(|i| i.contains("LedControl.h")));
        assert!(e.declarations.iter().any(|d| d.contains("LedControl matrix_mx_1(2, 3, 4, 1)")));
    }

    #[test]
    fn matrix_wakes_and_clears_on_setup() {
        let e = emit(&matrix("mx-1", json!({})), None);
        assert!(e.setup.iter().any(|s| s.contains("shutdown") && s.contains("false")));
        assert!(e.setup.iter().any(|s| s.contains("clearDisplay")));
    }

    #[test]
    fn matrix_lights_display_from_value() {
        let e = emit(&matrix("mx-1", json!({})), Some("btn_state"));
        assert!(e.loop_body.iter().any(|l| l.contains("setRow") && l.contains("btn_state")));
    }

    #[test]
    fn matrix_reads_custom_pins() {
        let e = emit(&matrix("mx-1", json!({ "pins": { "data": 7, "clock": 8, "cs": 9 }, "devices": 2 })), None);
        assert!(e.declarations.iter().any(|d| d.contains("(7, 8, 9, 2)")));
    }

    #[test]
    fn matrix_emits_deterministically() {
        let n = matrix("mx-1", json!({ "devices": 2 }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
