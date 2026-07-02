//! Wire-level parity tests for the sans-IO Firmata client. Byte sequences are
//! hand-built from the Firmata protocol spec / `StandardFirmata` behaviour so the
//! encoders and decoder are pinned independent of any board.

use super::*;

// --- Encoders ---------------------------------------------------------------

#[test]
fn set_pin_mode_emits_pin_mode_frame_and_caches_mode() {
    let mut c = FirmataClient::new();
    assert_eq!(c.encode_set_pin_mode(13, MODE_OUTPUT), vec![PIN_MODE, 13, MODE_OUTPUT]);
    assert_eq!(c.pins[13].mode, MODE_OUTPUT);
}

#[test]
fn digital_write_builds_port_byte_from_cached_values() {
    let mut c = FirmataClient::new();
    // pin 13 is in port 1 (pins 8..=15); bit index within port is 13-8 = 5.
    let bytes = c.encode_digital_write(13, true);
    assert_eq!(bytes, vec![DIGITAL_MESSAGE | 1, 1 << 5, 0]);
    assert_eq!(c.pins[13].value, 1);

    // Setting pin 8 high too ORs both bits into the same port byte.
    let bytes = c.encode_digital_write(8, true);
    assert_eq!(bytes, vec![DIGITAL_MESSAGE | 1, (1 << 5) | (1 << 0), 0]);
}

#[test]
fn analog_write_splits_value_into_two_seven_bit_bytes() {
    let mut c = FirmataClient::new();
    // 255 = 0b1111_1111 -> lsb 0x7F, msb 0x01; pin 9 -> ANALOG_MESSAGE | 9.
    assert_eq!(c.encode_analog_write(9, 255), vec![ANALOG_MESSAGE | 9, 0x7F, 0x01]);
    assert_eq!(c.pins[9].value, 255);
}

#[test]
fn reporting_frames_match_spec() {
    let c = FirmataClient::new();
    assert_eq!(c.encode_report_analog(0, true), vec![REPORT_ANALOG, 1]);
    assert_eq!(c.encode_report_analog(3, false), vec![REPORT_ANALOG | 3, 0]);
    assert_eq!(c.encode_report_digital(1, true), vec![REPORT_DIGITAL | 1, 1]);
}

#[test]
fn i2c_frames_match_spec() {
    let c = FirmataClient::new();
    assert_eq!(
        c.encode_i2c_config(0),
        vec![START_SYSEX, I2C_CONFIG, 0, 0, END_SYSEX]
    );
    // 7-bit split (firmware decodes argv[0] + (argv[1] << 7)), NOT an 8-bit u16
    // split. 16000 -> low7 = 16000 & 0x7F = 0, next7 = 16000 >> 7 = 125. An 8-bit
    // split would (wrongly) emit [128, 62] and the board would read 8064 µs.
    assert_eq!(
        c.encode_i2c_config(16000),
        vec![START_SYSEX, I2C_CONFIG, 0, 125, END_SYSEX]
    );
    assert_eq!(
        c.encode_i2c_read(0x08, 6),
        vec![START_SYSEX, I2C_REQUEST, 0x08, I2C_MODE_READ << 3, 6, 0, END_SYSEX]
    );
    // 0xFF write byte -> low 7 bits 0x7F, high bit 0x01.
    assert_eq!(
        c.encode_i2c_write(0x08, &[0xFF]),
        vec![START_SYSEX, I2C_REQUEST, 0x08, I2C_MODE_WRITE << 3, 0x7F, 0x01, END_SYSEX]
    );
    assert_eq!(
        c.encode_i2c_stop_reading(0x08),
        vec![START_SYSEX, I2C_REQUEST, 0x08, 0b11 << 3, END_SYSEX]
    );
    // Continuous read of register 0xB4 (=180 → lsb 52, msb 1), 8 bytes, with the
    // register sent inline (firmware `argc == 6` path) so it's re-applied each cycle.
    // STOP between write and read (no repeated-start — see encode_i2c_read_continuous).
    assert_eq!(
        c.encode_i2c_read_continuous(0x29, 0xB4, 8),
        vec![START_SYSEX, I2C_REQUEST, 0x29, I2C_MODE_READ_CONTINUOUS << 3, 52, 1, 8, 0, END_SYSEX]
    );
}

#[test]
fn sampling_interval_frame_matches_spec() {
    let c = FirmataClient::new();
    // 100ms -> lsb 100, msb 0; 200ms -> lsb 72 (200 & 0x7F), msb 1.
    assert_eq!(
        c.encode_sampling_interval(100),
        vec![START_SYSEX, SAMPLING_INTERVAL, 100, 0, END_SYSEX]
    );
    assert_eq!(
        c.encode_sampling_interval(200),
        vec![START_SYSEX, SAMPLING_INTERVAL, 72, 1, END_SYSEX]
    );
}

#[test]
fn query_and_sysex_frames_match_spec() {
    let c = FirmataClient::new();
    assert_eq!(c.encode_query_firmware(), vec![START_SYSEX, REPORT_FIRMWARE, END_SYSEX]);
    assert_eq!(c.encode_query_capabilities(), vec![START_SYSEX, CAPABILITY_QUERY, END_SYSEX]);
    assert_eq!(
        c.encode_query_analog_mapping(),
        vec![START_SYSEX, ANALOG_MAPPING_QUERY, END_SYSEX]
    );
    assert_eq!(
        c.encode_sysex(0x72, &[0x01, 0x02]),
        vec![START_SYSEX, 0x72, 0x01, 0x02, END_SYSEX]
    );
}

// --- Decoder ----------------------------------------------------------------

#[test]
fn decodes_protocol_version_in_octal() {
    let mut c = FirmataClient::new();
    let msgs = c.feed(&[PROTOCOL_VERSION, 2, 5]);
    assert_eq!(msgs, vec![Message::ProtocolVersion]);
    assert_eq!(c.protocol_version, "2.5");
}

#[test]
fn capability_response_populates_pin_modes() {
    let mut c = FirmataClient::new();
    // pin0: INPUT(res1), OUTPUT(res1) | sep | pin1: ANALOG(res10) | sep | END
    let frame = [
        START_SYSEX, CAPABILITY_RESPONSE,
        MODE_INPUT, 1, MODE_OUTPUT, 1, 127,
        MODE_ANALOG, 10, 127,
        END_SYSEX,
    ];
    let msgs = c.feed(&frame);
    assert_eq!(msgs, vec![Message::CapabilityResponse]);
    assert_eq!(c.pins[0].modes, vec![Mode { mode: MODE_INPUT, resolution: 1 }, Mode { mode: MODE_OUTPUT, resolution: 1 }]);
    assert_eq!(c.pins[1].modes, vec![Mode { mode: MODE_ANALOG, resolution: 10 }]);
}

#[test]
fn analog_mapping_response_flags_analog_pins() {
    let mut c = FirmataClient::new();
    c.pins = vec![Pin::default(); 3];
    // pin0 not analog, pin1 not analog, pin2 analog channel 0.
    let frame = [START_SYSEX, ANALOG_MAPPING_RESPONSE, 127, 127, 0, END_SYSEX];
    let msgs = c.feed(&frame);
    assert_eq!(msgs, vec![Message::AnalogMappingResponse]);
    assert!(!c.pins[0].analog);
    assert!(!c.pins[1].analog);
    assert!(c.pins[2].analog);
}

#[test]
fn capability_response_flags_analog_pins_without_analog_mapping() {
    // The ANALOG_MAPPING_RESPONSE trails a large capability dump and is easily
    // missed during detection (observed: a Nano whose pins all came back
    // `analogChannel: -1`). A pin advertising the ANALOG mode must therefore be
    // flagged analog from the capability alone, or analog reporting is refused
    // for every analog pin and the UI can't label A0..An. Regression for a dead
    // potentiometer + missing analog pin labels.
    let mut c = FirmataClient::new();
    // pin0: INPUT/OUTPUT (digital only). pin1: ANALOG-capable. No mapping sent.
    let frame = [
        START_SYSEX,
        CAPABILITY_RESPONSE,
        MODE_INPUT, 1, MODE_OUTPUT, 1, 127,
        MODE_ANALOG, 10, 127,
        END_SYSEX,
    ];
    let msgs = c.feed(&frame);
    assert_eq!(msgs, vec![Message::CapabilityResponse]);
    assert!(!c.pins[0].analog, "a digital-only pin must not be flagged analog");
    assert!(c.pins[1].analog, "a pin advertising ANALOG mode must be flagged analog");
}

#[test]
fn analog_message_updates_pin_14_offset() {
    let mut c = FirmataClient::new();
    c.pins = vec![Pin::default(); 20];
    // ANALOG_MESSAGE | 0 targets analog channel 0 == pin 14; value 0x10|(2<<7).
    let msgs = c.feed(&[ANALOG_MESSAGE, 0x10, 0x02]);
    assert_eq!(msgs, vec![Message::Analog]);
    assert_eq!(c.pins[14].value, 0x10 | (2 << 7));
}

#[test]
fn digital_message_updates_only_input_pins() {
    let mut c = FirmataClient::new();
    c.pins = vec![Pin::default(); 8];
    for p in &mut c.pins {
        p.mode = MODE_INPUT;
    }
    c.pins[1].mode = MODE_OUTPUT; // should not be overwritten by a report
    // port 0, value 0b0000_0111 -> pins 0,1,2 high (but pin1 is OUTPUT).
    let msgs = c.feed(&[DIGITAL_MESSAGE, 0b0000_0111, 0]);
    assert_eq!(msgs, vec![Message::Digital]);
    assert_eq!(c.pins[0].value, 1);
    assert_eq!(c.pins[1].value, 0, "OUTPUT pin must not be clobbered by a digital report");
    assert_eq!(c.pins[2].value, 1);
    assert_eq!(c.pins[3].value, 0);
}

#[test]
fn digital_message_updates_pullup_pins() {
    // A simple button is wired with the internal pull-up (MODE_PULLUP); its value
    // must update from a digital port report just like bare MODE_INPUT, or the
    // button node never sees a change and looks dead. Regression for the decode
    // that only accepted MODE_INPUT.
    let mut c = FirmataClient::new();
    c.pins = vec![Pin::default(); 8];
    c.pins[2].mode = MODE_PULLUP;
    c.pins[3].mode = MODE_OUTPUT; // output must still be ignored.
    // port 0, value 0b0000_1100 -> bits for pins 2 and 3 high.
    let msgs = c.feed(&[DIGITAL_MESSAGE, 0b0000_1100, 0]);
    assert_eq!(msgs, vec![Message::Digital]);
    assert_eq!(c.pins[2].value, 1, "PULLUP input pin must update from a digital report");
    assert_eq!(c.pins[3].value, 0, "OUTPUT pin must not be clobbered by a digital report");
}

#[test]
fn report_firmware_sets_name_and_version() {
    let mut c = FirmataClient::new();
    let frame = [START_SYSEX, REPORT_FIRMWARE, 2, 3, b'S', b'F', END_SYSEX];
    let msgs = c.feed(&frame);
    assert_eq!(msgs, vec![Message::ReportFirmware]);
    assert_eq!(c.firmware_version, "2.3");
    assert_eq!(c.firmware_name, "SF");
}

#[test]
fn i2c_reply_decodes_address_register_and_data() {
    let mut c = FirmataClient::new();
    let frame = [
        START_SYSEX, I2C_REPLY,
        0x08, 0, // address
        0x00, 0, // register
        0x42, 0, // data[0]
        0x13, 0, // data[1]
        END_SYSEX,
    ];
    let msgs = c.feed(&frame);
    assert_eq!(msgs, vec![Message::I2cReply]);
    assert_eq!(c.i2c_data.len(), 1);
    assert_eq!(c.i2c_data[0].address, 0x08);
    assert_eq!(c.i2c_data[0].register, 0x00);
    assert_eq!(c.i2c_data[0].data, vec![0x42, 0x13]);
}

#[test]
fn string_data_decodes_ascii_diagnostics() {
    let mut c = FirmataClient::new();
    // "Hi" as Firmata 7-bit (lsb, msb) pairs — the shape of an I2C error string.
    let frame = [START_SYSEX, STRING_DATA, b'H', 0, b'i', 0, END_SYSEX];
    let msgs = c.feed(&frame);
    assert_eq!(msgs, vec![Message::StringData]);
    assert_eq!(c.strings, vec!["Hi".to_string()]);
}

// --- Framing ----------------------------------------------------------------

#[test]
fn buffers_partial_message_across_feeds() {
    let mut c = FirmataClient::new();
    assert_eq!(c.feed(&[PROTOCOL_VERSION, 2]), vec![]);
    assert_eq!(c.pending_bytes(), 2);
    assert_eq!(c.feed(&[5]), vec![Message::ProtocolVersion]);
    assert_eq!(c.protocol_version, "2.5");
    assert_eq!(c.pending_bytes(), 0);
}

#[test]
fn resyncs_past_a_stray_leading_byte() {
    let mut c = FirmataClient::new();
    // A stray data byte (0x00) before a valid version message is dropped.
    let msgs = c.feed(&[0x00, PROTOCOL_VERSION, 2, 5]);
    assert_eq!(msgs, vec![Message::ProtocolVersion]);
    assert_eq!(c.protocol_version, "2.5");
}

#[test]
fn parses_multiple_messages_in_one_feed() {
    let mut c = FirmataClient::new();
    c.pins = vec![Pin::default(); 20];
    let mut stream = Vec::new();
    stream.extend_from_slice(&[PROTOCOL_VERSION, 2, 5]);
    stream.extend_from_slice(&[ANALOG_MESSAGE, 1, 0]);
    stream.extend_from_slice(&[START_SYSEX, REPORT_FIRMWARE, 2, 3, b'S', b'F', END_SYSEX]);
    let msgs = c.feed(&stream);
    assert_eq!(
        msgs,
        vec![Message::ProtocolVersion, Message::Analog, Message::ReportFirmware]
    );
    assert_eq!(c.firmware_name, "SF");
}

#[test]
fn incomplete_sysex_waits_for_end_marker() {
    let mut c = FirmataClient::new();
    assert_eq!(c.feed(&[START_SYSEX, REPORT_FIRMWARE, 2, 3]), vec![]);
    assert!(c.pending_bytes() > 0);
    assert_eq!(c.feed(&[b'S', b'F', END_SYSEX]), vec![Message::ReportFirmware]);
    assert_eq!(c.firmware_name, "SF");
}
