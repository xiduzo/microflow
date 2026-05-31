//! Tests for the pure flasher core: Intel-HEX parsing and USB board detection.

use super::*;

#[test]
fn hex_parses_a_simple_data_record() {
    // :10 0000 00 <16 bytes> CC  — one 16-byte data record at address 0.
    let line = ":100000000C9461000C9489000C9489000C94890014";
    let data = hex::parse(line).expect("valid hex");
    assert_eq!(data.len(), 16);
    assert_eq!(data[0], 0x0C);
    assert_eq!(data[1], 0x94);
    assert_eq!(data[2], 0x61);
}

#[test]
fn hex_fills_gaps_with_0xff() {
    // A record at address 0x0004 leaves bytes 0..4 unwritten -> 0xFF padding.
    let line = ":020004001234B4";
    let data = hex::parse(line).expect("valid hex");
    assert_eq!(&data[0..4], &[0xFF, 0xFF, 0xFF, 0xFF]);
    assert_eq!(data[4], 0x12);
    assert_eq!(data[5], 0x34);
}

#[test]
fn hex_stops_at_end_of_file_record() {
    let hex = ":0100000002FD\n:00000001FF\n:01000000AABB";
    let data = hex::parse(hex).expect("valid hex");
    // Only the first record before EOF is parsed.
    assert_eq!(data, vec![0x02]);
}

#[test]
fn hex_ignores_blank_and_non_colon_lines() {
    let hex = "\n; a comment\n:0100000002FD\n   \n";
    let data = hex::parse(hex).expect("valid hex");
    assert_eq!(data, vec![0x02]);
}

#[test]
fn hex_truncated_data_record_errors() {
    // byte_count says 0x10 bytes but the line carries far fewer.
    let line = ":100000001234";
    assert!(matches!(hex::parse(line), Err(FlashError::InvalidHex(_))));
}

#[test]
fn board_config_maps_protocol_and_signature() {
    assert_eq!(BoardConfig::find(BoardType::Uno).protocol, Protocol::Stk500v1);
    assert_eq!(BoardConfig::find(BoardType::Mega).protocol, Protocol::Stk500v2);
    assert_eq!(BoardConfig::find(BoardType::Leonardo).protocol, Protocol::Avr109);
    assert_eq!(BoardConfig::find(BoardType::Uno).signature, vec![0x1e, 0x95, 0x0f]);
    assert_eq!(BoardConfig::find(BoardType::Mega).page_size, 256);
}

#[test]
fn ch340_with_shared_pid_resolves_to_nano() {
    // PID 0x7523 is shared; CH340 VID (0x1a86) disambiguates to a Nano clone.
    assert_eq!(BoardConfig::detect_from_usb(0x1a86, 0x7523), Some(BoardType::Nano));
}

#[test]
fn official_arduino_uno_pid_detected() {
    // Arduino VID + Uno's unique PID 0x0043.
    assert_eq!(BoardConfig::detect_from_usb(0x2341, 0x0043), Some(BoardType::Uno));
}

#[test]
fn unique_micro_pid_resolves_to_micro() {
    assert_eq!(BoardConfig::detect_from_pid(0x8037), Some(BoardType::Micro));
}

#[test]
fn unknown_pid_is_none() {
    assert_eq!(BoardConfig::detect_from_pid(0xFFFF), None);
}
