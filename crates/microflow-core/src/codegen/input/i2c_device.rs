//! `I2cDevice` emitter — mirrors `runtime/input/i2c_device.rs`.
//!
//! The live `I2cDevice` configures the I2C bus, writes the register pointer,
//! reads `read_length` bytes, and decodes them as a big-endian unsigned or
//! signed integer (or leaves them raw). The generated sketch uses the Arduino
//! `Wire` library: it `#include <Wire.h>`, calls `Wire.begin()` in `setup()`,
//! and each loop writes the register, requests the bytes, and folds them into a
//! `long` value variable big-endian — the same decode the runtime applies for
//! the unsigned/signed integer formats. Downstream Nodes read that value.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Default I2C address matches `runtime/input/i2c_device.rs::default_address`.
const DEFAULT_ADDRESS: u8 = 0x48;
/// Default read length matches `runtime/input/i2c_device.rs::default_read_length`.
const DEFAULT_READ_LENGTH: u8 = 2;

/// The C++ `long` variable name holding this device's latest decoded reading.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("i2c_{}_value", node.id_token())
}

fn u8_field(node: &FlowNode, key: &str, default: u8) -> u8 {
    node.data
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u8::try_from(n).ok())
        .unwrap_or(default)
}

/// True when the configured output format treats the bytes as a signed integer.
fn is_signed(node: &FlowNode) -> bool {
    node.data
        .get("output")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("signed_int") || t.eq_ignore_ascii_case("signedint"))
}

/// Emit C++ for an `I2cDevice` Node.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let token = node.id_token();
    let value = value_var(node);
    let addr = u8_field(node, "address", DEFAULT_ADDRESS);
    let register = u8_field(node, "register", 0);
    let read_length = u8_field(node, "read_length", DEFAULT_READ_LENGTH).max(1);
    let signed = is_signed(node);

    let acc = format!("i2c_{token}_acc");
    let i = format!("i2c_{token}_i");
    let b = format!("i2c_{token}_b");

    let mut loop_body = vec![
        format!("Wire.beginTransmission((uint8_t){addr});"),
        format!("Wire.write((uint8_t){register});"),
        "Wire.endTransmission(false);".to_string(),
        format!("Wire.requestFrom((uint8_t){addr}, (uint8_t){read_length});"),
        format!("long {acc} = 0;"),
        format!("for (uint8_t {i} = 0; {i} < {read_length} && Wire.available(); {i}++) {{"),
        format!("  uint8_t {b} = Wire.read();"),
    ];
    if signed {
        // Sign-extend from the most-significant byte, big-endian, like the runtime.
        loop_body.push(format!("  if ({i} == 0 && ({b} & 0x80)) {{ {acc} = -1; }}"));
    }
    loop_body.push(format!("  {acc} = ({acc} << 8) | (long){b};"));
    loop_body.push("}".to_string());
    loop_body.push(format!("{value} = {acc};"));

    NodeEmission {
        includes: vec!["#include <Wire.h>".to_string()],
        declarations: vec![format!("long {value} = 0;")],
        setup: vec!["Wire.begin();".to_string()],
        loop_body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn i2c(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("I2cDevice".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn i2c_includes_wire_and_begins_bus() {
        let e = emit(&i2c("d-1", json!({})));
        assert!(e.includes.iter().any(|i| i.contains("Wire.h")));
        assert!(e.setup.iter().any(|s| s.contains("Wire.begin()")));
    }

    #[test]
    fn i2c_reads_configured_length_and_address() {
        let e = emit(&i2c("d-1", json!({ "address": 0x40, "read_length": 3 })));
        assert!(e.loop_body.iter().any(|l| l.contains("requestFrom") && l.contains("64")));
        assert!(e.loop_body.iter().any(|l| l.contains("< 3 &&")));
    }

    #[test]
    fn i2c_sign_extends_for_signed_format() {
        let e = emit(&i2c("d-1", json!({ "output": "signed_int" })));
        assert!(e.loop_body.iter().any(|l| l.contains("0x80")), "signed must sign-extend");
    }

    #[test]
    fn i2c_unsigned_does_not_sign_extend() {
        let e = emit(&i2c("d-1", json!({ "output": "unsigned_int" })));
        assert!(!e.loop_body.iter().any(|l| l.contains("0x80")));
    }

    #[test]
    fn i2c_emits_deterministically() {
        let n = i2c("d-1", json!({ "address": 0x48, "read_length": 2 }));
        assert_eq!(emit(&n), emit(&n));
    }
}
