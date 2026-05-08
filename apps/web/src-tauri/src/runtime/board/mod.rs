//! Hardware seam to the Firmata board.
//!
//! - [`BoardHandle`] — public flow-runtime seam; typed Firmata methods.
//! - `connection` — private `BoardConnection`, the firmata-rs wrapper.
//! - `io_loop` — private single-thread engine that owns the connection.
//! - `protocol` — private `BoardCommand`, the channel protocol.
//!
//! Reader-thread state (callbacks, pin caches) lives on shared `Arc`s held by
//! both `BoardHandle` and `BoardConnection`, so it does not flow through the
//! channel. Re-exported via `super::base` for backwards compatibility.

mod connection;
mod handle;
mod io_loop;
mod protocol;

pub use connection::{
    BoardConnection, I2cReplyCallback, I2cReplyEvent, PinChangeCallback, PinChangeEvent,
    SerialPortWrapper,
};
pub use handle::BoardHandle;
