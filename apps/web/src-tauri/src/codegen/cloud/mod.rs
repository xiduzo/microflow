//! Cloud-Node C++ emitters — the networked counterpart to the hardware-IO
//! emitters.
//!
//! Cloud Nodes (`Mqtt`, `Figma`, `Llm`, `Monitor`) cross the hardware boundary:
//! they talk to networked services and therefore only run on a `WiFi`-capable
//! target (e.g. the ESP32). Validation (#26/#35) already refuses a Cloud Node on
//! a non-networking board, so an emitter in this module may assume the target
//! offers [`crate::codegen::board::BoardCapability::Networking`].
//!
//! `Mqtt` (Task #38), `Figma` and `Monitor` (Task #42) have on-device emitters.
//! The remaining Cloud Node (`Llm`) still falls through to
//! [`crate::codegen::placeholder`] until its own task lands.
//!
//! `Figma` and `Monitor` both bridge over the **same network transport the Mqtt
//! Node uses** — `WiFi` + an MQTT client (`PubSubClient`). The shared
//! [`transport`] helper owns that broker bring-up so neither emitter duplicates
//! the connect logic; the `WiFi` setup itself is reused from
//! [`crate::codegen::credentials`] rather than re-emitted here.

pub mod figma;
pub mod monitor;
pub mod mqtt;
pub mod transport;
