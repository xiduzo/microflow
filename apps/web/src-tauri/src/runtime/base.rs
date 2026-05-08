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
    fn new_board_handle_is_not_connected() {
        let handle = BoardHandle::new();
        assert!(!handle.is_connected());
    }
}
