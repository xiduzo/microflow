//! The `Sensor` node, also registered as `Force`, `HallEffect`, `Ldr`,
//! `Potentiometer` and `Tilt`.

pub(crate) mod codegen;
pub(crate) mod config;
#[cfg(feature = "runtime")]
pub(crate) mod runtime;
