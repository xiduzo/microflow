//! Cloud-Node C++ emitters — the networked counterpart to the hardware-IO
//! emitters.
//!
//! Cloud Nodes (`Mqtt`, `Figma`, `Llm`, `Monitor`) cross the hardware boundary:
//! they talk to networked services and therefore only run on a `WiFi`-capable
//! target (e.g. the ESP32). Validation (#26/#35) already refuses a Cloud Node on
//! a non-networking board, so an emitter in this module may assume the target
//! offers [`crate::codegen::board::BoardCapability::Networking`].
//!
//! Only the `Mqtt` Node has an on-device emitter today (Task #38). The other
//! Cloud Nodes still fall through to [`crate::codegen::placeholder`] until their
//! own tasks land.

pub mod mqtt;
