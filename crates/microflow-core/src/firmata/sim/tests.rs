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
        for index in 0..layout.pin_count() as u8 {
            let caps = layout.caps(index);
            let pin = client.profile.caps(index).expect("pin described");
            assert_eq!(pin.analog_channel, caps.analog_channel, "{} pin {index}", layout.name());
            let modes: Vec<(u8, u8)> = pin.modes.iter().map(|m| (m.mode, m.resolution)).collect();
            assert_eq!(modes, caps.modes(), "{} pin {index}", layout.name());
        }
    }
}

/// The capability response ends every pin, the last one included, with `127`;
/// the table must come out exactly as long as the board, with no phantom pin
/// past `TOTAL_PINS` in the pin seed.
#[test]
fn capability_response_yields_exactly_the_boards_pins() {
    for layout in [BoardLayout::uno(), BoardLayout::mega2560(), BoardLayout::leonardo()] {
        let mut board = SimBoard::new(layout.clone());
        let client = probe(&mut board);
        assert_eq!(client.profile.len(), layout.pin_count(), "{}", layout.name());
        assert_eq!(client.pins.len(), layout.pin_count(), "{}", layout.name());
    }
}

/// The analog mapping is the board's: A0 is pin 14, 54 or 18.
#[test]
fn analog_channel_zero_is_the_boards_a0() {
    for layout in [BoardLayout::uno(), BoardLayout::mega2560(), BoardLayout::leonardo()] {
        let mut board = SimBoard::new(layout.clone());
        let client = probe(&mut board);
        assert_eq!(client.profile.analog_pin(0), layout.analog_pin(0), "{}", layout.name());
    }
}

/// `printFirmwareVersion` sends the name as 7-bit pairs; the codec slices the
/// raw bytes (copying `firmata-rs`), so a real board's name decodes with a NUL
/// after every character — "S\0t\0a\0n\0…" — wherever the hosts show it.
#[test]
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

/// Drive one of everything HIGH: an OUTPUT, a PWM duty, a servo and a pull-up
/// input (whose latch the reset would turn into a driven-high output).
fn drive_everything(board: &mut SimBoard) {
    let mut codec = FirmataClient::new();
    board.receive(&codec.encode_set_pin_mode(13, MODE_OUTPUT));
    board.receive(&codec.encode_digital_write(13, true));
    board.receive(&codec.encode_set_pin_mode(9, MODE_PWM));
    board.receive(&codec.encode_analog_write(9, 200));
    board.receive(&codec.encode_set_pin_mode(3, crate::firmata::MODE_SERVO));
    board.receive(&codec.encode_analog_write(3, 90));
    board.receive(&codec.encode_set_pin_mode(6, crate::firmata::MODE_PULLUP));
    assert!(board.pin(13).is_high() && board.pin(9).pwm() == Some(200) && board.pin(6).level());
}

/// `StandardFirmata`'s reset re-asserts OUTPUT without touching the latch
/// (StandardFirmata.ino `setPinModeCallback` / `systemResetCallback`): a pin
/// left HIGH stays HIGH, and a pull-up becomes an output driven HIGH.
#[test]
fn system_reset_alone_leaves_latched_pins_high() {
    let mut board = SimBoard::new(BoardLayout::uno());
    drive_everything(&mut board);
    board.receive(&[crate::firmata::SYSTEM_RESET]);
    assert!(board.pin(13).is_high(), "the OUTPUT latch survives the reset");
    assert!(board.pin(6).is_high(), "the pull-up latch becomes a HIGH output");
    assert!(!board.pin(9).is_high(), "PWM is driven low by the reset");
}

#[test]
fn safe_state_leaves_every_pin_low_on_every_layout() {
    for layout in [BoardLayout::uno(), BoardLayout::mega2560(), BoardLayout::leonardo()] {
        let mut board = SimBoard::new(layout.clone());
        let pins = probe(&mut board).profile;
        drive_everything(&mut board);
        board.receive(&crate::firmata::encode_safe_state(&pins));
        for pin in 0..layout.pin_count() as u8 {
            let p = board.pin(pin);
            assert!(!p.level(), "{} pin {pin} still HIGH in mode {:?}", layout.name(), p.mode());
            assert_eq!(p.servo(), None, "{} pin {pin} still a servo", layout.name());
            assert_eq!(p.pwm(), None, "{} pin {pin} still PWM", layout.name());
        }
        assert!(!board.is_reporting_digital(0) && !board.is_reporting_analog(0));
    }
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
    /// re-announces. The runtime reads the re-announce from its own decode and
    /// re-applies the flow (ADR-0018 § "What would make merging worth it").
    #[test]
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

    /// After a reset the outputs the flow drove come back, through the node's
    /// own state (the LED knows its pin left PWM mode with the reboot).
    #[test]
    fn a_reset_restores_plain_outputs_without_emitting() {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(
            vec![
                node("led", "Led", json!({ "pin": 13 })),
                node("dim", "Led", json!({ "pin": 9 })),
                node("relay", "Relay", json!({ "pin": 7 })),
            ],
            vec![],
        );
        rig.dispatch("led", "true", true);
        rig.dispatch("dim", "value", 128.0);
        rig.dispatch("relay", "true", true);
        rig.take_events();

        rig.board.reset();
        assert!(!rig.board.pin(13).is_high(), "the reboot lowered it");
        rig.pump();
        assert_eq!(rig.board.boots(), 2);
        assert!(rig.board.pin(13).is_high(), "LED on again");
        assert_eq!(rig.board.pin(9).pwm(), Some(128), "PWM duty restored");
        assert!(rig.board.pin(7).is_high(), "relay open again");
        assert!(rig.events().is_empty(), "nothing changed as far as the flow knows: {:?}", rig.events());

        // The rebuilt LED still drives its pin: a later PWM value lands.
        rig.dispatch("dim", "value", 64.0);
        assert_eq!(rig.board.pin(9).pwm(), Some(64));
        assert!(rig.board.violations().is_empty(), "{:?}", rig.board.violations());
    }

    /// The reboot forgot the I2C bus and its continuous reads; the re-apply
    /// configures the bus and re-arms the read, and the device streams again.
    #[test]
    fn a_reset_re_arms_i2c_streaming() {
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
        rig.board.reset();
        rig.pump();
        assert!(rig.board.i2c_enabled(), "bus configured again");
        assert_eq!(rig.board.i2c_queries().len(), 1, "exactly one read re-armed");
        rig.take_events();
        rig.board.i2c_device(0x29).set_registers(0x14, &[0x33, 0x44]);
        rig.sample();
        assert!(
            rig.events().iter().any(|e| e.source.as_ref() == "dev"),
            "the device streams after the reset: {:?}",
            rig.events()
        );
    }

    /// A reset under a pull-up button: the re-apply sets the mode before it
    /// switches reporting on, so the idle line does not read as a press.
    #[test]
    fn a_reset_does_not_flash_a_pullup_button_pressed() {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(vec![node("btn", "Button", json!({ "pin": 2, "isPullup": true }))], vec![]);
        rig.advance(100);
        rig.take_events();
        rig.board.reset();
        rig.pump();
        rig.advance(100);
        assert!(!rig.handles_from("btn").contains(&"true"), "{:?}", rig.events());
    }

    /// The board resets while it is part-way through an I2C reply: the reply's
    /// `F7` never comes, and the boot announcement follows the cut frame. The
    /// re-announce must still be seen, or the flow goes silent.
    #[test]
    fn a_reset_mid_i2c_reply_still_re_applies_the_flow() {
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
        rig.board.sample(); // a reply is on the wire…
        rig.board.reset(); // …when the board reboots and announces itself
        rig.board.cut_next_sysex(5); // the reply loses its tail and F7
        rig.pump();
        assert_eq!(rig.board.boots(), 2);
        assert!(rig.board.i2c_enabled(), "the re-apply configured the bus again");
        assert_eq!(rig.board.i2c_queries().len(), 1, "and re-armed the read");
    }

    /// The same with a `STRING_DATA` frame cut by the reset.
    #[test]
    fn a_reset_mid_string_data_still_re_applies_the_flow() {
        let mut rig = button_rig(BoardLayout::uno());
        rig.board.inject_output(&[START_SYSEX, crate::firmata::STRING_DATA, 0x41, 0x00]);
        rig.board.reset();
        rig.pump();
        assert!(rig.board.is_reporting_digital(0), "reporting re-enabled after the reset");
        press(&mut rig, true);
        assert!(rig.handles_from("btn").contains(&"true"), "{:?}", rig.events());
    }

    /// Reset the board `times` times, a second apart, the relay open each time.
    fn reset_repeatedly(rig: &mut SimRig, times: usize) {
        for _ in 0..times {
            rig.advance(1_000);
            rig.board.reset();
            rig.pump();
        }
    }

    /// The last runtime-origin diagnostic sent for `node`, if any was.
    fn resetting_badge(rig: &SimRig, node: &str) -> Option<crate::runtime::NodeDiagnostic> {
        rig.diagnostics()
            .iter()
            .rev()
            .find(|d| d.node == node && d.origin == crate::runtime::DiagnosticOrigin::Runtime)
            .cloned()
    }

    fn relay_rig() -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(vec![node("relay", "Relay", json!({ "pin": 7 }))], vec![]);
        rig.dispatch("relay", "true", true);
        rig.take_events();
        rig
    }

    /// A relay on the board's own 5 V rail: re-closing it browns the board out,
    /// which resets and re-announces. After three resets in 30 s the runtime
    /// stops re-driving it, says why on the node, and restores it once the
    /// board has been quiet for 30 s.
    #[test]
    fn a_board_that_keeps_resetting_holds_its_outputs_until_it_is_quiet() {
        let mut rig = relay_rig();
        reset_repeatedly(&mut rig, 2);
        assert!(rig.board.pin(7).is_high(), "two resets: still restored");
        assert!(resetting_badge(&rig, "relay").is_none());

        reset_repeatedly(&mut rig, 1);
        assert!(!rig.board.pin(7).is_high(), "the third reset in 30 s holds it off");
        let badge = resetting_badge(&rig, "relay").and_then(|d| d.message).expect("a badge on the held node");
        assert!(badge.contains("keeps resetting") && badge.contains("power supply"), "{badge}");

        // Still resetting: still held, and the value to restore is not lost.
        reset_repeatedly(&mut rig, 1);
        assert!(!rig.board.pin(7).is_high());

        // Quiet for 30 s: the next chunk from the board restores it.
        rig.advance(30_000);
        rig.board.inject_output(&[0xF9, 2, 5]);
        rig.pump();
        assert!(rig.board.pin(7).is_high(), "restored once the board is quiet");
        assert!(resetting_badge(&rig, "relay").is_some_and(|d| d.message.is_none()), "badge cleared");
        assert!(rig.events().is_empty(), "nothing emitted: {:?}", rig.events());
    }

    /// Resets spread wider than the window are each restored.
    #[test]
    fn resets_far_apart_are_not_a_storm() {
        let mut rig = relay_rig();
        for _ in 0..4 {
            rig.advance(20_000);
            rig.board.reset();
            rig.pump();
            assert!(rig.board.pin(7).is_high());
        }
        assert!(resetting_badge(&rig, "relay").is_none());
    }

    /// A flow update ends the storm: the badge clears and the count restarts.
    #[test]
    fn a_flow_update_ends_a_reset_storm() {
        let mut rig = relay_rig();
        reset_repeatedly(&mut rig, 3);
        assert!(resetting_badge(&rig, "relay").is_some_and(|d| d.message.is_some()));
        rig.apply_flow(vec![node("relay", "Relay", json!({ "pin": 7 }))], vec![]);
        assert!(resetting_badge(&rig, "relay").is_some_and(|d| d.message.is_none()));
        rig.dispatch("relay", "true", true);
        reset_repeatedly(&mut rig, 1);
        assert!(rig.board.pin(7).is_high(), "a fresh count: one reset is restored");
    }

    /// A reply cut short (its `F7` lost) must cost that one reply only: the
    /// next status byte ends the cut frame, so the next, intact reply is
    /// decoded rather than swallowed into one garbage frame.
    #[test]
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

    /// Stock firmware ignores the Pixel and `AccelStepper` sysex. Its capability
    /// response advertises neither mode, so each node says so on its badge
    /// (origin: runtime) and sends nothing the board would drop.
    #[test]
    fn stock_firmware_missing_an_extension_raises_a_diagnostic() {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(
            vec![
                node("strip", "Pixel", json!({ "pin": 6, "length": 4 })),
                node("motor", "Stepper", json!({})),
            ],
            vec![],
        );
        assert!(rig.board.refused_sysex().is_empty(), "{:02X?}", rig.board.refused_sysex());
        let badges: Vec<_> = rig
            .diagnostics()
            .iter()
            .map(|d| (d.node.as_str(), d.origin, d.message.clone().unwrap_or_default()))
            .collect();
        assert_eq!(badges.len(), 2, "{badges:?}");
        for (node, origin, message) in &badges {
            assert_eq!(*origin, crate::runtime::DiagnosticOrigin::Runtime, "{node}");
            let flash = if *node == "strip" { "StandardFirmata" } else { "ConfigurableFirmata" };
            assert!(message.contains("firmware does not support") && message.contains(flash), "{node}: {message}");
        }
    }

    /// Firmware with the extension advertises it, and the node runs quietly.
    #[test]
    fn firmware_with_the_extension_raises_nothing() {
        let board = SimBoard::new(BoardLayout::uno())
            .with_extension(Extension::Pixel)
            .with_extension(Extension::AccelStepper);
        let mut rig = SimRig::connect(board);
        rig.apply_flow(
            vec![
                node("strip", "Pixel", json!({ "pin": 6, "length": 4 })),
                node("motor", "Stepper", json!({})),
            ],
            vec![],
        );
        assert!(rig.diagnostics().is_empty(), "{:?}", rig.diagnostics());
        assert!(rig.board.pixel_strip().is_some() && rig.board.stepper(0).is_some());
    }
}
