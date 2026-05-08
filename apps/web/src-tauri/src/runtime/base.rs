//! Re-export shim. Definitions moved to:
//! - `component.rs` — Component trait, ComponentValue, ComponentEvent, ComponentBase, PinConfig.
//! - `board.rs` — BoardHandle, BoardConnection, BoardCommand, SerialPortWrapper,
//!   PinChangeEvent, I2cReplyEvent, callback type aliases.
//! - `pin_mode.rs` — Firmata pin mode constants.
//! - `serde_utils.rs` — pin/string deserializers.
//!
//! Existing imports of `crate::runtime::base::{...}` and `super::base::{...}`
//! continue to work transparently.

pub use super::board::*;
pub use super::component::*;

pub use super::pin_mode;
pub use super::serde_utils;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_command_digital_write_round_trips() {
        let cmd = BoardCommand::DigitalWrite { pin: 13, value: true };
        match cmd {
            BoardCommand::DigitalWrite { pin, value } => {
                assert_eq!(pin, 13);
                assert!(value);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn board_command_reset_all_reporting_is_unit() {
        let cmd = BoardCommand::ResetAllReporting;
        assert!(matches!(cmd, BoardCommand::ResetAllReporting));
    }

    #[test]
    fn board_command_stop_is_unit() {
        let cmd = BoardCommand::Stop;
        assert!(matches!(cmd, BoardCommand::Stop));
    }

    #[test]
    fn new_board_handle_is_not_connected() {
        let handle = BoardHandle::new();
        assert!(!handle.is_connected());
    }

    #[test]
    fn send_command_returns_err_when_not_connected() {
        let handle = BoardHandle::new();
        let result = handle.send_command(BoardCommand::ResetAllReporting);
        assert!(result.is_err(), "send_command must fail when not connected");
        assert!(result.unwrap_err().to_string().contains("not connected"));
    }

    #[test]
    fn active_pins_tracking() {
        use std::collections::HashSet;
        let mut active: HashSet<u8> = HashSet::new();
        active.insert(2);
        active.insert(14);
        assert!(active.contains(&2));
        assert!(active.contains(&14));
        assert!(!active.contains(&13));
        active.clear();
        assert!(active.is_empty(), "clear_pin_cache should reset active pins");
    }
}
