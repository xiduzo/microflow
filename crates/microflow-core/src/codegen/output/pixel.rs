//! Pixel emitter — mirrors `runtime/output/pixel.rs`.
//!
//! The live Pixel drives an addressable `NeoPixel` strip (WS2812-style). It
//! configures the strip length, pin and colour order, and pushes per-pixel
//! colours, clearing the strip on initialize. The generated sketch uses the
//! Adafruit `NeoPixel` library: it `#include <Adafruit_NeoPixel.h>`, declares a
//! strip object sized to the configured length on the configured pin with the
//! matching colour order, calls `begin()` + `clear()` + `show()` in `setup()`
//! (mirroring the runtime's off-on-init), and — when wired from an upstream
//! brightness value — fills the whole strip with that grayscale level each loop.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::config::pixel::PixelConfig;
use crate::flow::FlowNode;

/// Map the configured colour-order string to the `NeoPixel` type flag.
fn neo_color_flag(color_order: &str) -> &'static str {
    match color_order.to_ascii_uppercase().as_str() {
        "RGB" => "NEO_RGB + NEO_KHZ800",
        "BRG" => "NEO_BRG + NEO_KHZ800",
        // GRB is the WS2812 default and the runtime default.
        _ => "NEO_GRB + NEO_KHZ800",
    }
}

/// Emit C++ for a Pixel Node. `driver` is an optional grayscale brightness
/// (0..=255) applied to every pixel; `None` leaves the strip cleared.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let obj = format!("pixel_{token}");
    let config: PixelConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let pin = config.pin;
    let length = config.length.max(1);
    let flag = neo_color_flag(&config.color_order);
    let i = format!("pixel_{token}_i");

    let mut e = NodeEmission {
        includes: vec!["#include <Adafruit_NeoPixel.h>".to_string()],
        declarations: vec![format!(
            "Adafruit_NeoPixel {obj}({length}, {pin}, {flag});"
        )],
        setup: vec![
            format!("{obj}.begin();"),
            // Mirror runtime initialize: cleared.
            format!("{obj}.clear();"),
            format!("{obj}.show();"),
        ],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        let level = format!("constrain((int)({expr}), 0, 255)");
        e.loop_body.push(format!("int {token}_level = {level};"));
        e.loop_body.push(format!(
            "for (uint16_t {i} = 0; {i} < {length}; {i}++) {{"
        ));
        e.loop_body.push(format!(
            "  {obj}.setPixelColor({i}, {obj}.Color({token}_level, {token}_level, {token}_level));"
        ));
        e.loop_body.push("}".to_string());
        e.loop_body.push(format!("{obj}.show();"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn pixel(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Pixel".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn pixel_includes_library_and_declares_strip() {
        let e = emit(&pixel("px-1", json!({ "pin": 6, "length": 16 })), None);
        assert!(e.includes.iter().any(|i| i.contains("Adafruit_NeoPixel.h")));
        assert!(e.declarations.iter().any(|d| d.contains("Adafruit_NeoPixel pixel_px_1(16, 6")));
    }

    #[test]
    fn pixel_begins_and_clears_on_setup() {
        let e = emit(&pixel("px-1", json!({})), None);
        assert!(e.setup.iter().any(|s| s.contains(".begin()")));
        assert!(e.setup.iter().any(|s| s.contains(".clear()")));
    }

    #[test]
    fn pixel_fills_strip_from_value() {
        let e = emit(&pixel("px-1", json!({ "length": 8 })), Some("sensor_x_value"));
        assert!(e.loop_body.iter().any(|l| l.contains("setPixelColor")));
        assert!(e.loop_body.iter().any(|l| l.contains("sensor_x_value")));
        assert!(e.loop_body.iter().any(|l| l.contains(".show()")));
    }

    #[test]
    fn pixel_honours_color_order() {
        let e = emit(&pixel("px-1", json!({ "color_order": "RGB" })), None);
        assert!(e.declarations.iter().any(|d| d.contains("NEO_RGB")));
    }

    #[test]
    fn pixel_emits_deterministically() {
        let n = pixel("px-1", json!({ "length": 12 }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
