//! `I2cDevice` emitter — mirrors `runtime/input/i2c_device.rs`.
//!
//! The live `I2cDevice` configures the I2C bus, writes the register pointer,
//! reads `read_length` bytes, and decodes them as a big-endian unsigned or
//! signed integer (or leaves them raw). The generated sketch uses the Arduino
//! `Wire` library: it `#include <Wire.h>`, calls `Wire.begin()` in `setup()`,
//! and on each due read writes the register, requests the bytes, and folds
//! them into a `long` value variable big-endian — the same decode the runtime
//! applies for the unsigned/signed integer formats. Downstream Nodes read that
//! value.
//!
//! A read becomes *due* exactly when the runtime twin would read: every
//! `sample_interval_ms` while `autoread` streams (the board's sampling
//! interval), and on any `trigger` pulse — the runtime dispatches `trigger`
//! to `request_read` unconditionally, so a trigger is an extra manual read even
//! while streaming. Everything is `millis()`-gated; the no-hold `SHT2x` settle
//! wait is a two-phase request→collect state machine, never a blocking
//! `delay()` (the module-wide invariant).

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, NodeInputs};
use crate::config::i2c_device::{ByteDecode, I2cDeviceConfig, OutputFormat};
use crate::flow::FlowNode;

/// The C++ `long` variable name holding this device's latest decoded reading.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("i2c_{}_value", node.id_token())
}

/// Emit C++ for an `I2cDevice` Node. With `autoread` on the device reads every
/// `sample_interval_ms`; a wired `trigger` port fires an extra read on each
/// pulse (streaming or not — the runtime's `trigger` dispatch is unguarded).
/// With `autoread` off and no trigger wired the device never reads and the
/// value stays at its 0 default, matching the runtime where nothing is armed.
/// The `write` port carries raw byte payloads with no on-device value model;
/// wiring it emits a note.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    // Deserialize the SAME config the runtime builds from (ungated in
    // `crate::config::i2c_device`), so codegen and interpret never disagree on
    // field parsing or defaults. Malformed data falls back to defaults rather
    // than erroring — the sketch generator has no per-node failure channel.
    let config: I2cDeviceConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();

    let token = node.id_token();
    let value = value_var(node);
    let addr = config.address;
    let register = effective_register(&config);
    let read_length = config.read_length.max(1);
    // The shared decode descriptor this emitter TRANSCRIBES (the runtime
    // interprets the same one via `fold_bytes`). Raw has no on-device
    // byte-array value model, so it folds like unsigned — recorded in
    // `codegen/parity.rs`.
    let sign_extend =
        matches!(config.output.decode(), ByteDecode::Fold { sign_extend: true });

    let acc = format!("i2c_{token}_acc");
    let i = format!("i2c_{token}_i");
    let b = format!("i2c_{token}_b");

    // No-hold sensors (SHT2x/HTU21) NACK until their conversion completes, so
    // the command write must end with a STOP and the collect must wait out the
    // settle window. Other devices keep the repeated-start (no STOP) read.
    let delay_ms = read_delay_ms(&config);
    let stop_tx = if delay_ms > 0 { "true" } else { "false" };
    let request = [
        format!("Wire.beginTransmission((uint8_t){addr});"),
        format!("Wire.write((uint8_t){register});"),
        format!("Wire.endTransmission({stop_tx});"),
    ];
    let mut collect = vec![
        format!("Wire.requestFrom((uint8_t){addr}, (uint8_t){read_length});"),
        format!("long {acc} = 0;"),
        format!("for (uint8_t {i} = 0; {i} < {read_length} && Wire.available(); {i}++) {{"),
        format!("  uint8_t {b} = Wire.read();"),
    ];
    // The fold transcribed from the descriptor: big-endian shift-or, optionally
    // sign-extended from bit 7 of the first byte, capped at `FOLD_BYTE_CAP`
    // bytes. A longer read still drains the Wire buffer, but only the FIRST cap
    // bytes fold in — exactly `fold_bytes`' `take(4)`. (The old uncapped fold
    // kept the LAST 4 bytes of a long read; the runtime keeps the first 4.)
    let mut fold = Vec::new();
    if sign_extend {
        fold.push(format!("if ({i} == 0 && ({b} & 0x80)) {{ {acc} = -1; }}"));
    }
    fold.push(format!("{acc} = ({acc} << 8) | (long){b};"));
    if usize::from(read_length) > OutputFormat::FOLD_BYTE_CAP {
        let cap = OutputFormat::FOLD_BYTE_CAP;
        fold = std::iter::once(format!("if ({i} < {cap}) {{"))
            .chain(fold.into_iter().map(|l| format!("  {l}")))
            .chain(std::iter::once("}".to_string()))
            .collect();
    }
    collect.extend(fold.into_iter().map(|l| format!("  {l}")));
    collect.push("}".to_string());
    collect.push(format!("{value} = {acc};"));

    // A read is due exactly when the runtime twin would read: once per
    // sampling interval while `autoread` streams, and on any `trigger` pulse —
    // the runtime dispatches `trigger` to `request_read` unconditionally, so a
    // trigger is an extra manual read even while streaming. With neither, the
    // device never reads and the value stays at its 0 default, matching the
    // runtime where no continuous read is armed and nothing calls
    // `request_read`.
    let mut declarations = vec![format!("long {value} = 0;")];
    let mut loop_body = Vec::new();
    let mut interval_seed = None;
    let binding = bind_pulses(&format!("i2c_{token}_trigger"), inputs.on("trigger"));
    let trigger_any = binding.any_fired();
    if config.autoread || trigger_any.is_some() {
        declarations.extend(binding.declarations.iter().cloned());
        loop_body.extend(binding.loop_lines.iter().cloned());
        let due = format!("i2c_{token}_due");
        loop_body.push(format!("bool {due} = false;"));
        if config.autoread {
            // The sampling gate, `millis()`-compared like every timer in the
            // module. Re-basing to `millis()` (not `+= interval`) skips
            // catch-up bursts after a stalled loop — the board samples the
            // bus, it does not backfill missed samples.
            let previous = format!("i2c_{token}_previous");
            let interval = config.sample_interval_ms.max(1);
            declarations.push(format!("unsigned long {previous} = 0;"));
            interval_seed = Some(format!("{previous} = millis();"));
            loop_body.push(format!(
                "if (millis() - {previous} >= {interval}UL) {{ {previous} = millis(); {due} = true; }}"
            ));
        }
        if let Some(any) = &trigger_any {
            loop_body.push(format!("if ({any}) {{ {due} = true; }}"));
        }
        if delay_ms > 0 {
            // Two-phase non-blocking settle: write the command, then collect
            // once the conversion window has elapsed. A read that comes due
            // mid-conversion is dropped — the transaction in flight is the one
            // it would have started.
            let pending = format!("i2c_{token}_pending");
            let requested_at = format!("i2c_{token}_requested_at");
            declarations.push(format!("bool {pending} = false;"));
            declarations.push(format!("unsigned long {requested_at} = 0;"));
            loop_body.push(format!("if ({due} && !{pending}) {{"));
            loop_body.extend(request.iter().map(|l| format!("  {l}")));
            loop_body.push(format!("  {requested_at} = millis();"));
            loop_body.push(format!("  {pending} = true;"));
            loop_body.push("}".to_string());
            loop_body
                .push(format!("if ({pending} && millis() - {requested_at} >= {delay_ms}UL) {{"));
            loop_body.push(format!("  {pending} = false;"));
            loop_body.extend(collect.iter().map(|l| format!("  {l}")));
            loop_body.push("}".to_string());
        } else {
            loop_body.push(format!("if ({due}) {{"));
            loop_body.extend(request.iter().map(|l| format!("  {l}")));
            loop_body.extend(collect.iter().map(|l| format!("  {l}")));
            loop_body.push("}".to_string());
        }
    }
    if !inputs.on("write").is_empty() {
        declarations.push(
            "// note: input 'write' carries raw byte payloads codegen cannot express on-device — edge ignored"
                .to_string(),
        );
    }

    // Power on / configure known devices once in setup(), mirroring the runtime's
    // `device_init_writes`. Keyed off the `device` preset id so generic/custom
    // devices emit nothing extra.
    let mut setup = vec!["Wire.begin();".to_string()];
    for &payload in crate::config::i2c_device::device_init_writes(&config.device) {
        setup.push(format!("Wire.beginTransmission((uint8_t){addr});"));
        for &byte in payload {
            setup.push(format!("Wire.write((uint8_t){byte});"));
        }
        setup.push("Wire.endTransmission();".to_string());
    }
    // Seed the sampling gate so the first read lands one interval after boot —
    // the runtime's continuous read also delivers its first reply one sampling
    // interval after being armed.
    setup.extend(interval_seed);

    NodeEmission {
        includes: vec!["#include <Wire.h>".to_string()],
        declarations,
        setup,
        loop_body,
        ..NodeEmission::default()
    }
}

/// The register actually read, with the hold-master → no-hold safety override.
/// Delegates to the shared [`crate::config::i2c_device::effective_register`] (see
/// there for why a stale hold-master 0xE3/0xE5 must be remapped before it hangs
/// the AVR bus). Sharing it also gives codegen the runtime's stale-label
/// normalisation, which the old hand-mirrored copy lacked.
fn effective_register(config: &I2cDeviceConfig) -> u8 {
    crate::config::i2c_device::effective_register(&config.device, config.address, config.register)
}

/// Delay (ms) inserted between the register write and the read for no-hold
/// sensors that NACK until their conversion completes. The *classification* is
/// shared ([`crate::config::i2c_device::is_no_hold_sht2x`]); the magnitude is
/// codegen's own — the generated sketch uses a plain `delay()` (not Firmata's
/// 7-bit-capped `I2C_CONFIG`), so 30ms is safe and leaves more margin over the 15ms
/// worst-case 11-bit conversion. Zero ⇒ repeated-start immediate read.
fn read_delay_ms(config: &I2cDeviceConfig) -> u32 {
    if crate::config::i2c_device::is_no_hold_sht2x(&config.device) { 30 } else { 0 }
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

    /// A single boolean source wired into the `trigger` port.
    fn trigger_input(expr: &str) -> NodeInputs {
        use crate::codegen::wire::{CppExpr, SourceExpr};
        let mut inputs = NodeInputs::default();
        inputs.add("trigger", SourceExpr::level(CppExpr::boolean(expr)));
        inputs
    }

    #[test]
    fn i2c_includes_wire_and_begins_bus() {
        let e = emit(&i2c("d-1", json!({})), &NodeInputs::default());
        assert!(e.includes.iter().any(|i| i.contains("Wire.h")));
        assert!(e.setup.iter().any(|s| s.contains("Wire.begin()")));
    }

    #[test]
    fn i2c_reads_configured_length_and_address() {
        // camelCase `readLength` — the key the web actually sends.
        let e = emit(&i2c("d-1", json!({ "address": 0x40, "readLength": 3 })), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains("requestFrom") && l.contains("64")));
        assert!(e.loop_body.iter().any(|l| l.contains("< 3 &&")));
    }

    #[test]
    fn i2c_snake_case_read_length_is_ignored() {
        // Guard the rename: the old snake_case key must NOT be honored, else the
        // runtime (camelCase) and codegen would disagree on byte count.
        let e = emit(&i2c("d-1", json!({ "read_length": 8 })), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains("< 2 &&")), "must fall back to default 2");
    }

    #[test]
    fn i2c_tcs34725_enables_adc_in_setup() {
        let e = emit(&i2c("d-1", json!({ "device": "tcs34725", "address": 0x29 })), &NodeInputs::default());
        // ENABLE register 0x80 = 128, value 3 written once in setup().
        assert!(e.setup.iter().any(|s| s.contains("128")), "must write ENABLE register");
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)3)")));
    }

    #[test]
    fn i2c_custom_device_emits_no_init_writes() {
        let e = emit(&i2c("d-1", json!({ "device": "custom" })), &NodeInputs::default());
        // No init transmissions for generic devices — just the bus begin and
        // the sampling-gate seed.
        assert!(!e.setup.iter().any(|s| s.contains("beginTransmission")));
        assert_eq!(e.setup[0], "Wire.begin();");
    }

    #[test]
    fn i2c_mpu6050_wakes_from_sleep_in_setup() {
        let e = emit(&i2c("d-1", json!({ "device": "mpu6050", "address": 0x68 })), &NodeInputs::default());
        // PWR_MGMT_1 (0x6B = 107) = 0x00 clears the SLEEP bit in setup().
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)107)")), "must write PWR_MGMT_1");
        assert!(e.setup.iter().any(|s| s.contains("(uint8_t)104")), "must address the MPU6050");
    }

    #[test]
    fn i2c_bmp280_configures_without_a_humidity_write() {
        let e = emit(&i2c("d-1", json!({ "device": "bmp280_pressure", "address": 0x76 })), &NodeInputs::default());
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
        let e = emit(&i2c("d-1", json!({ "device": "MPU6050", "address": 0x68 })), &NodeInputs::default());
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)107)")), "stale label must still wake");
    }

    #[test]
    fn i2c_sht21_uses_stop_and_delay_and_sets_resolution() {
        let e = emit(
            &i2c(
                "d-1",
                json!({ "device": "sht21_temp", "address": 0x40, "register": 0xF3, "readLength": 2 }),
            ),
            &NodeInputs::default(),
        );
        // No-hold: STOP after the command write, then a non-blocking settle —
        // the collect phase waits out the conversion on millis(), never delay().
        assert!(e.loop_body.iter().any(|l| l.contains("Wire.endTransmission(true)")));
        assert!(
            e.loop_body
                .iter()
                .any(|l| l.contains("i2c_d_1_pending && millis() - i2c_d_1_requested_at >= 30UL")),
            "must wait out the settle window without blocking"
        );
        assert!(!e.loop_body.iter().any(|l| l.trim_start().starts_with("delay(")), "no blocking delay");
        // Resolution write to the user register (0xE6 = 230, 0x83 = 131) in setup.
        assert!(e.setup.iter().any(|s| s.contains("230")), "must write user register");
        assert!(e.setup.iter().any(|s| s.contains("Wire.write((uint8_t)131)")));
    }

    #[test]
    fn i2c_sht21_stale_hold_master_register_is_remapped() {
        // A doc saved before the no-hold preset change still carries 0xE3 (=227);
        // the sketch must write the no-hold 0xF3 (=243) instead, never the
        // bus-hanging hold-master register.
        let e = emit(&i2c("d-1", json!({ "device": "sht21_temp", "register": 0xE3 })), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains("Wire.write((uint8_t)243)")), "must remap to 0xF3");
        assert!(!e.loop_body.iter().any(|l| l.contains("Wire.write((uint8_t)227)")), "must not emit 0xE3");
    }

    #[test]
    fn i2c_non_sht_keeps_repeated_start_without_settle_state() {
        let e = emit(&i2c("d-1", json!({ "device": "tcs34725", "address": 0x29 })), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains("Wire.endTransmission(false)")));
        assert!(!e.loop_body.iter().any(|l| l.contains("_pending")), "no settle machine needed");
    }

    #[test]
    fn i2c_sign_extends_for_signed_format() {
        let e = emit(&i2c("d-1", json!({ "output": "signed_int" })), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains("0x80")), "signed must sign-extend");
    }

    #[test]
    fn i2c_folds_at_most_four_bytes_like_the_runtime() {
        // Drift fix: the old fold folded ALL bytes, so a >4-byte read kept the
        // LAST 4 bytes in the 32-bit `long` while the runtime keeps the FIRST 4
        // (`fold_bytes`). The emitted fold must be guarded at the shared cap.
        let e = emit(&i2c("d-1", json!({ "readLength": 6 })), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains("< 4) {")), "long reads must cap the fold");
        // Reads within the cap need no guard — the loop bound already limits them.
        let e = emit(&i2c("d-1", json!({ "readLength": 4 })), &NodeInputs::default());
        assert!(!e.loop_body.iter().any(|l| l.contains("< 4) {")), "no guard within the cap");
    }

    #[test]
    fn i2c_unsigned_does_not_sign_extend() {
        let e = emit(&i2c("d-1", json!({ "output": "unsigned_int" })), &NodeInputs::default());
        assert!(!e.loop_body.iter().any(|l| l.contains("0x80")));
    }

    #[test]
    fn i2c_autoread_streams_on_sampling_interval_and_honors_trigger() {
        // Absent `autoread` ⇒ streaming at the default 100ms sampling interval
        // — never every 1ms loop tick — AND a wired trigger still fires an
        // extra manual read: the runtime dispatches `trigger` to
        // `request_read` unguarded, streaming or not.
        let e = emit(&i2c("d-1", json!({})), &trigger_input("btn_state"));
        assert!(
            e.loop_body
                .iter()
                .any(|l| l.contains("millis() - i2c_d_1_previous >= 100UL")),
            "streaming is gated at the default sampling interval"
        );
        assert!(e.loop_body.iter().any(|l| l.contains("btn_state")), "trigger still honored");
        assert!(e.loop_body.iter().any(|l| l.contains("requestFrom")), "must read");
        assert!(e.setup.iter().any(|s| s.contains("i2c_d_1_previous = millis()")), "gate seeded");
    }

    #[test]
    fn i2c_autoread_honors_configured_freq_key() {
        // The web persists the sampling period under the key `freq` (a period
        // in ms despite the name — see I2cDeviceConfig).
        let e = emit(&i2c("d-1", json!({ "freq": 250 })), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains(">= 250UL")), "configured period wins");
    }

    #[test]
    fn i2c_autoread_off_reads_only_on_trigger_rising_edge() {
        // autoread off + trigger wired ⇒ the read is gated behind the source's
        // rising edge (the generated twin of the runtime `trigger` handle).
        let e = emit(&i2c("d-1", json!({ "autoread": false })), &trigger_input("btn_state"));
        assert!(
            e.declarations.iter().any(|d| d.contains("i2c_d_1_trigger_prev0")),
            "tracks previous edge"
        );
        assert!(
            e.loop_body.iter().any(|l| l.contains("!= i2c_d_1_trigger_prev0")),
            "reads only when the trigger source changes",
        );
        assert!(e.loop_body.iter().any(|l| l.contains("requestFrom")), "still performs the read");
    }

    #[test]
    fn i2c_autoread_off_without_trigger_never_reads() {
        // autoread off + no driver ⇒ no read at all (value stays 0), mirroring the
        // runtime where nothing is armed and no trigger source exists.
        let e = emit(&i2c("d-1", json!({ "autoread": false })), &NodeInputs::default());
        assert!(!e.loop_body.iter().any(|l| l.contains("requestFrom")), "must not read");
        assert_eq!(e.declarations, vec!["long i2c_d_1_value = 0;".to_string()]);
    }

    #[test]
    fn i2c_emits_deterministically() {
        let n = i2c("d-1", json!({ "address": 0x48, "read_length": 2 }));
        assert_eq!(emit(&n, &NodeInputs::default()), emit(&n, &NodeInputs::default()));
    }
}
