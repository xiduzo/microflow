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

/// Whether the device streams every loop (`true`, default) or reads only when
/// its `trigger` input fires (`false`). Mirrors the runtime config's `autoread`
/// (default on) — an absent key keeps a pre-`autoread` doc streaming.
fn autoread(node: &FlowNode) -> bool {
    node.data.get("autoread").and_then(serde_json::Value::as_bool).unwrap_or(true)
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

/// Emit C++ for an `I2cDevice` Node. `driver` is the optional upstream trigger
/// expression: when `autoread` is off the read fires on its rising edge (the
/// generated twin of the runtime's `trigger` handle), otherwise it is ignored
/// because the device streams every loop.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let value = value_var(node);
    let addr = u8_field(node, "address", DEFAULT_ADDRESS);
    let register = effective_register(node);
    // Web sends camelCase keys; mirrors the runtime config's `rename_all`.
    let read_length = u8_field(node, "readLength", DEFAULT_READ_LENGTH).max(1);
    let signed = is_signed(node);

    let acc = format!("i2c_{token}_acc");
    let i = format!("i2c_{token}_i");
    let b = format!("i2c_{token}_b");

    // No-hold sensors (SHT2x/HTU21) NACK until their conversion completes, so the
    // command write must end with a STOP and be followed by a delay before the
    // read. Other devices keep the repeated-start (no STOP, no delay) read.
    let delay_ms = read_delay_ms(node);
    let stop_tx = if delay_ms > 0 { "true" } else { "false" };
    let mut loop_body = vec![
        format!("Wire.beginTransmission((uint8_t){addr});"),
        format!("Wire.write((uint8_t){register});"),
        format!("Wire.endTransmission({stop_tx});"),
    ];
    if delay_ms > 0 {
        loop_body.push(format!("delay({delay_ms});"));
    }
    loop_body.extend([
        format!("Wire.requestFrom((uint8_t){addr}, (uint8_t){read_length});"),
        format!("long {acc} = 0;"),
        format!("for (uint8_t {i} = 0; {i} < {read_length} && Wire.available(); {i}++) {{"),
        format!("  uint8_t {b} = Wire.read();"),
    ]);
    if signed {
        // Sign-extend from the most-significant byte, big-endian, like the runtime.
        loop_body.push(format!("  if ({i} == 0 && ({b} & 0x80)) {{ {acc} = -1; }}"));
    }
    loop_body.push(format!("  {acc} = ({acc} << 8) | (long){b};"));
    loop_body.push("}".to_string());
    loop_body.push(format!("{value} = {acc};"));

    // `autoread` off ⇒ trigger-only: read on the driver's rising edge (mirrors the
    // runtime `trigger` handle), not every loop. With no upstream trigger wired the
    // device never reads — the value stays at its 0 default, matching the runtime,
    // where no continuous read is armed and nothing calls `request_read`.
    let mut declarations = vec![format!("long {value} = 0;")];
    if !autoread(node) {
        loop_body = match driver {
            Some(expr) => {
                let prev = format!("i2c_{token}_prev");
                let trig = format!("i2c_{token}_trig");
                declarations.push(format!("bool {prev} = false;"));
                let mut gated = vec![
                    format!("bool {trig} = (bool)({expr});"),
                    format!("if ({trig} && !{prev}) {{"),
                ];
                gated.extend(loop_body.into_iter().map(|l| format!("  {l}")));
                gated.push("}".to_string());
                gated.push(format!("{prev} = {trig};"));
                gated
            }
            None => Vec::new(),
        };
    }

    // Power on / configure known devices once in setup(), mirroring the runtime's
    // `device_init_writes`. Keyed off the `device` preset id so generic/custom
    // devices emit nothing extra.
    let mut setup = vec!["Wire.begin();".to_string()];
    for &payload in device_init_writes(node) {
        setup.push(format!("Wire.beginTransmission((uint8_t){addr});"));
        for &byte in payload {
            setup.push(format!("Wire.write((uint8_t){byte});"));
        }
        setup.push("Wire.endTransmission();".to_string());
    }

    NodeEmission {
        includes: vec!["#include <Wire.h>".to_string()],
        declarations,
        setup,
        loop_body,
    }
}

/// The `device` preset id from the Node, or `""` when absent (→ no init).
fn device_id(node: &FlowNode) -> &str {
    node.data.get("device").and_then(serde_json::Value::as_str).unwrap_or("")
}

/// One-time I2C writes a known device needs before it produces data. Delegates to
/// the ungated [`crate::config::i2c_device::device_init_writes`] table so the
/// generated sketch's `setup()` stays byte-identical to the live runtime's
/// `initialize()` — one source, no hand-mirroring drift.
fn device_init_writes(node: &FlowNode) -> &'static [&'static [u8]] {
    crate::config::i2c_device::device_init_writes(device_id(node))
}

/// The register actually read, with the hold-master → no-hold safety override.
/// Delegates to the shared [`crate::config::i2c_device::effective_register`] (see
/// there for why a stale hold-master 0xE3/0xE5 must be remapped before it hangs
/// the AVR bus). Sharing it also gives codegen the runtime's stale-label
/// normalisation, which the old hand-mirrored copy lacked.
fn effective_register(node: &FlowNode) -> u8 {
    let register = u8_field(node, "register", 0);
    let addr = u8_field(node, "address", DEFAULT_ADDRESS);
    crate::config::i2c_device::effective_register(device_id(node), addr, register)
}

/// Delay (ms) inserted between the register write and the read for no-hold
/// sensors that NACK until their conversion completes. The *classification* is
/// shared ([`crate::config::i2c_device::is_no_hold_sht2x`]); the magnitude is
/// codegen's own — the generated sketch uses a plain `delay()` (not Firmata's
/// 7-bit-capped `I2C_CONFIG`), so 30ms is safe and leaves more margin over the 15ms
/// worst-case 11-bit conversion. Zero ⇒ repeated-start immediate read.
fn read_delay_ms(node: &FlowNode) -> u32 {
    if crate::config::i2c_device::is_no_hold_sht2x(device_id(node)) { 30 } else { 0 }
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
        let e = emit(&i2c("d-1", json!({})), None);
        assert!(e.includes.iter().any(|i| i.contains("Wire.h")));
        assert!(e.setup.iter().any(|s| s.contains("Wire.begin()")));
    }

    #[test]
    fn i2c_reads_configured_length_and_address() {
        // camelCase `readLength` — the key the web actually sends.
        let e = emit(&i2c("d-1", json!({ "address": 0x40, "readLength": 3 })), None);
        assert!(e.loop_body.iter().any(|l| l.contains("requestFrom") && l.contains("64")));
        assert!(e.loop_body.iter().any(|l| l.contains("< 3 &&")));
    }

    #[test]
    fn i2c_snake_case_read_length_is_ignored() {
        // Guard the rename: the old snake_case key must NOT be honored, else the
        // runtime (camelCase) and codegen would disagree on byte count.
        let e = emit(&i2c("d-1", json!({ "read_length": 8 })), None);
        assert!(e.loop_body.iter().any(|l| l.contains("< 2 &&")), "must fall back to default 2");
    }

    #[test]
    fn i2c_tcs34725_enables_adc_in_setup() {
        let e = emit(&i2c("d-1", json!({ "device": "tcs34725", "address": 0x29 })), None);
        // ENABLE register 0x80 = 128, value 3 written once in setup().
        assert!(e.setup.iter().any(|s| s.contains("128")), "must write ENABLE register");
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)3)")));
    }

    #[test]
    fn i2c_custom_device_emits_no_init_writes() {
        let e = emit(&i2c("d-1", json!({ "device": "custom" })), None);
        // Only Wire.begin() — no extra transmissions for generic devices.
        assert_eq!(e.setup, vec!["Wire.begin();".to_string()]);
    }

    #[test]
    fn i2c_mpu6050_wakes_from_sleep_in_setup() {
        let e = emit(&i2c("d-1", json!({ "device": "mpu6050", "address": 0x68 })), None);
        // PWR_MGMT_1 (0x6B = 107) = 0x00 clears the SLEEP bit in setup().
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)107)")), "must write PWR_MGMT_1");
        assert!(e.setup.iter().any(|s| s.contains("(uint8_t)104")), "must address the MPU6050");
    }

    #[test]
    fn i2c_bmp280_configures_without_a_humidity_write() {
        let e = emit(&i2c("d-1", json!({ "device": "bmp280_pressure", "address": 0x76 })), None);
        // ctrl_meas (0xF4 = 244) + config (0xF5 = 245); NO ctrl_hum (0xF2 = 242).
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)244)")), "must write ctrl_meas");
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)245)")), "must write config");
        assert!(!e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)242)")), "BMP280 has no ctrl_hum");
    }

    #[test]
    fn i2c_stale_device_label_still_initialises_in_sketch() {
        // Regression: codegen used to match the raw `device` id, so a stale leva
        // label ("MPU6050") skipped the init in the generated sketch while the
        // runtime (which normalised) still emitted it. Routing both through the
        // shared normalised table removes that divergence.
        let e = emit(&i2c("d-1", json!({ "device": "MPU6050", "address": 0x68 })), None);
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)107)")), "stale label must still wake");
    }

    #[test]
    fn i2c_sht21_uses_stop_and_delay_and_sets_resolution() {
        let e = emit(
            &i2c(
                "d-1",
                json!({ "device": "sht21_temp", "address": 0x40, "register": 0xF3, "readLength": 2 }),
            ),
            None,
        );
        // No-hold: STOP after the command write, then a delay before the read.
        assert!(e.loop_body.iter().any(|l| l.contains("Wire.endTransmission(true)")));
        assert!(e.loop_body.iter().any(|l| l.starts_with("delay(")), "must delay before read");
        // Resolution write to the user register (0xE6 = 230, 0x83 = 131) in setup.
        assert!(e.setup.iter().any(|s| s.contains("230")), "must write user register");
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)131)")));
    }

    #[test]
    fn i2c_sht21_stale_hold_master_register_is_remapped() {
        // A doc saved before the no-hold preset change still carries 0xE3 (=227);
        // the sketch must write the no-hold 0xF3 (=243) instead, never the
        // bus-hanging hold-master register.
        let e = emit(&i2c("d-1", json!({ "device": "sht21_temp", "register": 0xE3 })), None);
        assert!(e.loop_body.iter().any(|l| l.contains("Wire.write((uint8_t)243)")), "must remap to 0xF3");
        assert!(!e.loop_body.iter().any(|l| l.contains("Wire.write((uint8_t)227)")), "must not emit 0xE3");
    }

    #[test]
    fn i2c_non_sht_keeps_repeated_start_without_delay() {
        let e = emit(&i2c("d-1", json!({ "device": "tcs34725", "address": 0x29 })), None);
        assert!(e.loop_body.iter().any(|l| l.contains("Wire.endTransmission(false)")));
        assert!(!e.loop_body.iter().any(|l| l.starts_with("delay(")), "non-no-hold must not delay");
    }

    #[test]
    fn i2c_sign_extends_for_signed_format() {
        let e = emit(&i2c("d-1", json!({ "output": "signed_int" })), None);
        assert!(e.loop_body.iter().any(|l| l.contains("0x80")), "signed must sign-extend");
    }

    #[test]
    fn i2c_unsigned_does_not_sign_extend() {
        let e = emit(&i2c("d-1", json!({ "output": "unsigned_int" })), None);
        assert!(!e.loop_body.iter().any(|l| l.contains("0x80")));
    }

    #[test]
    fn i2c_autoread_default_reads_every_loop_ignoring_driver() {
        // Absent `autoread` ⇒ streaming: the read runs unconditionally every loop,
        // even with a driver wired (matches the runtime, which streams on the
        // sampling interval and treats `trigger` as an extra manual read).
        let e = emit(&i2c("d-1", json!({})), Some("btn_state"));
        assert!(e.loop_body.iter().any(|l| l.contains("requestFrom")), "must read");
        assert!(!e.loop_body.iter().any(|l| l.contains("btn_state")), "streaming ignores driver");
        assert!(!e.declarations.iter().any(|d| d.contains("_prev")), "no edge state when streaming");
    }

    #[test]
    fn i2c_autoread_off_reads_only_on_trigger_rising_edge() {
        // autoread off + driver wired ⇒ the read is gated behind the driver's
        // rising edge (the generated twin of the runtime `trigger` handle).
        let e = emit(&i2c("d-1", json!({ "autoread": false })), Some("btn_state"));
        assert!(e.declarations.iter().any(|d| d.contains("i2c_d_1_prev")), "tracks previous edge");
        assert!(
            e.loop_body.iter().any(|l| l.contains("i2c_d_1_trig") && l.contains("!i2c_d_1_prev")),
            "reads only on rising edge",
        );
        assert!(e.loop_body.iter().any(|l| l.contains("requestFrom")), "still performs the read");
    }

    #[test]
    fn i2c_autoread_off_without_trigger_never_reads() {
        // autoread off + no driver ⇒ no read at all (value stays 0), mirroring the
        // runtime where nothing is armed and no trigger source exists.
        let e = emit(&i2c("d-1", json!({ "autoread": false })), None);
        assert!(!e.loop_body.iter().any(|l| l.contains("requestFrom")), "must not read");
        assert_eq!(e.declarations, vec!["long i2c_d_1_value = 0;".to_string()]);
    }

    #[test]
    fn i2c_emits_deterministically() {
        let n = i2c("d-1", json!({ "address": 0x48, "read_length": 2 }));
        assert_eq!(emit(&n, None), emit(&n, None));
    }
}
