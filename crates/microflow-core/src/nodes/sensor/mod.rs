//! The `Sensor` node, also registered as `Force`, `HallEffect`, `Ldr`,
//! `Potentiometer` and `Tilt`.

pub(crate) mod codegen;
#[cfg(feature = "runtime")]
pub(crate) mod runtime;
