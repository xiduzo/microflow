//! The `Midi` node.
//!
//! A host-peripheral node with the cloud nodes' sans-IO shape, so its runtime
//! sits behind `cloud`. Unlike the networked cloud nodes it needs NO networking
//! on-device: the emitter speaks serial MIDI over the board's hardware UART
//! (MIDI.h), so it runs on every board.

pub mod codegen;
pub mod config;
#[cfg(feature = "cloud")]
pub mod runtime;
