//! Hardware seam to the Firmata board.
//!
//! - [`BoardHandle`] — public flow-runtime seam; typed Firmata methods.
//! - `connection` — private `BoardConnection`, the serial port + sans-IO codec.
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
mod receipt;
mod test_io_loop;

pub use connection::{
    BoardConnection, I2cReplyCallback, I2cReplyEvent, PinChangeCallback, PinChangeEvent,
};
pub use handle::BoardHandle;
pub use protocol::BoardCommand;
pub use receipt::{CommandReceipt, PinSnapshot};
pub use test_io_loop::TestIoLoop;
