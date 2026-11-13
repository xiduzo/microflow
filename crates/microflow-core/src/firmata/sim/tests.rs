//! The sim board's own contract (it answers like `StandardFirmata`), and the
//! board-level fault scenarios run end to end through a [`SimRig`].

use super::*;
use crate::firmata::{FirmataClient, MODE_ANALOG, MODE_OUTPUT, MODE_PWM};

/// Run the detection handshake against `board` on a fresh codec.
fn probe(board: &mut SimBoard) -> FirmataClient {
    let mut client = FirmataClient::new();
    client.feed(&board.take_output());
    board.receive(&client.encode_query_firmware());
    board.receive(&client.encode_query_capabilities());
    board.receive(&client.encode_query_analog_mapping());
    client.feed(&board.take_output());
    client
}

#[test]
fn handshake_describes_every_layout() {
    for layout in [BoardLayout::uno(), BoardLayout::mega2560(), BoardLayout::leonardo()] {
        let mut board = SimBoard::new(layout.clone());
        let client = probe(&mut board);
        assert_eq!(client.protocol_version, "2.5", "{}", layout.name());
        assert_eq!(client.firmware_version, "2.5", "{}", layout.name());
        for (index, pin) in client.pins.iter().take(layout.pin_count()).enumerate() {
            let caps = layout.caps(index as u8);
            assert_eq!(pin.analog, caps.analog_channel.is_some(), "{} pin {index}", layout.name());
            let modes: Vec<(u8, u8)> = pin.modes.iter().map(|m| (m.mode, m.resolution)).collect();
            assert_eq!(modes, caps.modes(), "{} pin {index}", layout.name());
        }
    }
}

/// The capability response ends every pin, the last one included, with `127`;
/// the codec opens a new pin on each `127`, so the table comes out one pin
/// longer than the board — a phantom pin past `TOTAL_PINS` in every pin seed.
#[test]
#[ignore = "track I: CAPABILITY_RESPONSE decode appends a phantom pin after the final 127"]
fn capability_response_yields_exactly_the_boards_pins() {
    for layout in [BoardLayout::uno(), BoardLayout::mega2560(), BoardLayout::leonardo()] {
        let mut board = SimBoard::new(layout.clone());
        assert_eq!(probe(&mut board).pins.len(), layout.pin_count(), "{}", layout.name());
    }
}

/// `printFirmwareVersion` sends the name as 7-bit pairs; the codec slices the
/// raw bytes (copying `firmata-rs`), so a real board's name decodes with a NUL
/// after every character — "S\0t\0a\0n\0…" — wherever the hosts show it.
#[test]
#[ignore = "track I: codec decodes REPORT_FIRMWARE's name without recombining its 7-bit pairs"]
fn firmware_name_decodes_as_text() {
    let mut board = SimBoard::new(BoardLayout::uno()).with_firmware("StandardFirmata.ino", 2, 5);
    let client = probe(&mut board);
    assert_eq!(client.firmware_name, "StandardFirmata.ino");
}

#[test]
fn boot_defaults_put_analog_pins_in_analog_mode_and_digital_pins_low() {
    let board = SimBoard::new(BoardLayout::uno());
    assert_eq!(board.pin(14).mode(), Some(MODE_ANALOG));
    assert_eq!(board.pin(13).mode(), Some(MODE_OUTPUT));
    assert!(!board.pin(13).is_high());
    assert_eq!(board.pin(0).mode(), None, "serial pins have no mode");
    assert!(!board.is_reporting_analog(0));
    assert!(!board.is_reporting_digital(0));
    assert_eq!(board.boots(), 1);
}

#[test]
fn firmware_ignores_analog_writes_to_pins_outside_pwm_and_servo_mode() {
    let mut board = SimBoard::new(BoardLayout::uno());
    let mut codec = FirmataClient::new();
    // PWM on pin 13 is not a capability of the Uno: the mode is refused…
    board.receive(&codec.encode_set_pin_mode(13, MODE_PWM));
    assert_eq!(board.pin(13).mode(), Some(MODE_OUTPUT));
    // …and the analog write that follows is dropped.
    board.receive(&codec.encode_analog_write(13, 128));
    assert!(!board.pin(13).is_high());
    assert_eq!(board.violations().len(), 2, "{:?}", board.violations());
}

#[test]
fn stop_reading_with_one_query_left_clears_it_whatever_the_address() {
    let mut board = SimBoard::new(BoardLayout::uno());
    let codec = FirmataClient::new();
    board.receive(&codec.encode_i2c_config(0));
    board.receive(&codec.encode_i2c_read_continuous(0x40, 0, 2));
    // A stop for an address that is not streaming still clears the lone query
    // — the StandardFirmata quirk the runtime's drain count is built around.
    board.receive(&codec.encode_i2c_stop_reading(0x29));
    assert!(board.i2c_queries().is_empty());
}

#[test]
fn nacking_device_gets_an_empty_reply_and_a_string() {
    let mut board = SimBoard::new(BoardLayout::uno());
    board.take_output();
    let mut codec = FirmataClient::new();
    board.receive(&codec.encode_i2c_config(0));
    board.i2c_device(0x29).set_registers(0x14, &[1, 2]).set_nack(true);
    board.receive(&codec.encode_i2c_read(0x29, 2));
    codec.feed(&board.take_output());
    assert_eq!(codec.strings, vec!["I2C: Too few bytes received".to_string()]);
    assert_eq!(codec.i2c_data.len(), 1);
    assert!(codec.i2c_data[0].data.is_empty());
}

#[test]
fn reports_survive_any_chunking() {
    let mut board = SimBoard::new(BoardLayout::uno());
    let bytes = board.take_output();
    let mut codec = FirmataClient::new();
    for b in &bytes {
        codec.feed(std::slice::from_ref(b));
    }
    assert_eq!(codec.firmware_version, "2.5");
    assert_eq!(codec.pending_bytes(), 0);
}

#[cfg(feature = "runtime")]
mod through_the_runtime {
    use super::super::rig::{node, SimRig};
    use super::*;
    use serde_json::json;

    fn button_rig(layout: BoardLayout) -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(layout));
        rig.apply_flow(vec![node("btn", "Button", json!({ "pin": 2 }))], vec![]);
        rig.take_events();
        rig
    }

    fn press(rig: &mut SimRig, high: bool) {
        rig.advance(100);
        rig.board.drive_pin(2, high);
        rig.pump();
    }

    #[test]
    fn rig_handshake_seeds_the_runtime_pin_table() {
        let rig = SimRig::connect(SimBoard::new(BoardLayout::mega2560()));
        assert_eq!(rig.board.boots(), 1);
        // A flow on pin 69 (A15) only reaches the board if the seed covered it.
        let mut rig = rig;
        rig.apply_flow(vec![node("led", "Led", json!({ "pin": 53 }))], vec![]);
        rig.dispatch("led", "true", true);
        assert!(rig.board.pin(53).is_high());
    }

    #[test]
    fn a_dropped_byte_loses_one_report_and_the_stream_resyncs() {
        let mut rig = button_rig(BoardLayout::uno());
        rig.board.drop_output_bytes(1);
        press(&mut rig, true);
        assert!(rig.handles_from("btn").is_empty(), "the report lost its status byte");
        press(&mut rig, false);
        press(&mut rig, true);
        assert!(rig.handles_from("btn").contains(&"true"), "{:?}", rig.events());
    }

    /// An AVR reset over a USB-serial chip keeps the port open: the board
    /// reboots, forgets the button's INPUT mode and the port's reporting, and
    /// re-announces. Nothing in the runtime reacts to the re-announce, so the
    /// flow goes quiet (ADR-0018 § "What would make merging worth it").
    #[test]
    #[ignore = "track J: runtime does not re-apply the flow when a connected board re-announces (REPORT_FIRMWARE mid-session)"]
    fn flow_survives_a_board_reset_mid_session() {
        let mut rig = button_rig(BoardLayout::uno());
        press(&mut rig, true);
        press(&mut rig, false);
        rig.take_events();

        rig.board.reset();
        rig.pump();
        assert_eq!(rig.board.boots(), 2);
        press(&mut rig, true);
        assert!(rig.handles_from("btn").contains(&"true"), "{:?}", rig.events());
    }

    /// A reply cut short (its `F7` lost) must cost that one reply only. The
    /// codec scans to the next `F7` without treating a status byte as a frame
    /// boundary, so the next, intact reply is swallowed into one garbage frame
    /// whose misaligned bytes reach the node as data.
    #[test]
    #[ignore = "track I: codec framing — a sysex cut short swallows the next frame (status byte inside sysex is not a boundary)"]
    fn a_cut_sysex_costs_one_reply_not_the_next() {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.board.i2c_device(0x29).set_registers(0x14, &[0x11, 0x22]);
        rig.apply_flow(
            vec![node(
                "dev",
                "I2cDevice",
                json!({ "address": 0x29, "register": 0x14, "readLength": 2, "output": "raw" }),
            )],
            vec![],
        );
        rig.take_events();
        rig.board.cut_next_sysex(4);
        rig.sample();
        rig.board.i2c_device(0x29).set_registers(0x14, &[0x33, 0x44]);
        rig.sample();
        let values: Vec<_> = rig.events().iter().filter(|e| e.source.as_ref() == "dev").map(|e| e.value.clone()).collect();
        assert_eq!(
            values,
            vec![ComponentValue::Array(vec![ComponentValue::Number(51.0), ComponentValue::Number(68.0)])],
            "only the intact reply may reach the node"
        );
    }

    use crate::runtime::ComponentValue;

    /// Line noise between frames (stray data bytes, an unknown status) must not
    /// wedge the decoder.
    #[test]
    fn line_noise_between_reports_is_skipped() {
        let mut rig = button_rig(BoardLayout::uno());
        rig.board.inject_output(&[0x01, 0x7F, 0x55, 0xF3]);
        press(&mut rig, true);
        assert!(rig.handles_from("btn").contains(&"true"), "{:?}", rig.events());
    }

    /// Stock firmware ignores the Pixel and `AccelStepper` sysex; the flow gets
    /// no signal that the strip or motor will never move.
    #[test]
    fn stock_firmware_refuses_extension_sysex_silently() {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(
            vec![
                node("strip", "Pixel", json!({ "pin": 6, "length": 4 })),
                node("motor", "Stepper", json!({})),
            ],
            vec![],
        );
        let refused = rig.board.refused_sysex();
        assert!(refused.contains(&PIXEL_COMMAND), "{refused:02X?}");
        assert!(refused.contains(&ACCELSTEPPER_DATA), "{refused:02X?}");
        assert!(rig.board.pixel_strip().is_none());
        assert!(rig.diagnostics().is_empty(), "no diagnostic today: {:?}", rig.diagnostics());
    }
}
