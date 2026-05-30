//! Cloud-Node C++ emitters — the networked counterpart to the hardware-IO
//! emitters.
//!
//! Cloud Nodes (`Mqtt`, `Figma`, `Llm`, `Monitor`) cross the hardware boundary:
//! they talk to networked services and therefore only run on a `WiFi`-capable
//! target (e.g. the ESP32). Validation (#26/#35) already refuses a Cloud Node on
//! a non-networking board, so an emitter in this module may assume the target
//! offers [`crate::codegen::board::BoardCapability::Networking`].
//!
//! The `Mqtt` (Task #38) and `Llm` (Task #44) Nodes have on-device emitters
//! today. The remaining Cloud Nodes (Figma/Monitor) still fall through to
//! [`crate::codegen::placeholder`] until their own tasks land.

pub mod llm;
pub mod mqtt;
