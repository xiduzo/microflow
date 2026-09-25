//! The `Sensor` node, also registered as `Force`, `HallEffect`, `Ldr`,
//! `Potentiometer` and `Tilt`.

pub mod codegen;
#[cfg(feature = "runtime")]
pub mod runtime;
