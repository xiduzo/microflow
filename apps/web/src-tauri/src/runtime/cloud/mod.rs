//! Cloud nodes (`Mqtt`, `Llm`, `Figma`) re-homed onto the `microflow-core`
//! `Component` trait.
//!
//! These nodes do async network I/O (MQTT publish, LLM generation) that the
//! sans-IO core deliberately has no concept of. The "desktop-only cloud"
//! resolution: the nodes stay in the desktop crate (so `microflow-core` pulls
//! no tokio/reqwest/mqtt dependencies), implement core's [`Component`], and keep
//! their service handles plus a captured [`tokio::runtime::Handle`] to spawn
//! work.
//!
//! - **Publishes are fire-and-forget** — `dispatch` spawns the async publish and
//!   returns immediately; nothing needs to flow back.
//! - **Results that must re-enter the runtime** (an LLM response) cross back over
//!   a [`CloudEmitter`]. The core's emit queue is `!Send` and cannot be touched
//!   from a spawned task on another thread, so the spawned task hands
//!   `(source, handle, value)` to the host, which calls
//!   `FlowRuntime::inject_event` on the owner thread and applies the `Effects`.
//!
//! The host registers these via `FlowRuntime::register_node`, with factory
//! closures capturing the live `MqttManager` / `LlmRegistry` / runtime handle.
//!
//! [`Component`]: microflow_core::runtime::Component

use microflow_core::runtime::ComponentValue;
use std::sync::Arc;

pub mod figma;
pub mod llm;
pub mod mqtt;

/// `Send` seam for asynchronous cloud-node results to re-enter the
/// single-threaded core. A spawned task (e.g. an LLM generation) calls
/// [`emit`](CloudEmitter::emit) with the emitting node's id, the output handle,
/// and the value; the host forwards it to the runtime's owner thread, which
/// calls `FlowRuntime::inject_event` and applies the resulting `Effects`.
pub trait CloudEmitter: Send + Sync {
    fn emit(&self, source: Arc<str>, handle: &'static str, value: ComponentValue);
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::CloudEmitter;
    use microflow_core::firmata::FirmataClient;
    use microflow_core::runtime::{
        BufferBoardWriter, ComponentValue, RuntimeContext, ScheduleRequests,
    };
    use std::sync::{Arc, Mutex};

    /// Build a throwaway [`RuntimeContext`] and run `f` with it. Cloud nodes
    /// ignore the board / clock / scheduler, so the discarded buffer + client
    /// are just there to satisfy the borrow.
    pub fn with_test_ctx<R>(node_id: &str, f: impl FnOnce(&mut RuntimeContext) -> R) -> R {
        let mut client = FirmataClient::new();
        let mut out = Vec::new();
        let mut writer = BufferBoardWriter::new(&mut client, &mut out);
        let mut reqs = ScheduleRequests::default();
        let mut ctx = RuntimeContext::new(&mut writer, 0.0, node_id, &mut reqs);
        f(&mut ctx)
    }

    /// Records cloud-node async emits for assertions.
    #[derive(Default)]
    pub struct RecordingCloudEmitter {
        events: Mutex<Vec<(Arc<str>, String, ComponentValue)>>,
    }

    impl RecordingCloudEmitter {
        #[must_use]
        pub fn new() -> Self {
            Self::default()
        }

        pub fn recorded(&self) -> Vec<(Arc<str>, String, ComponentValue)> {
            self.events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    impl CloudEmitter for RecordingCloudEmitter {
        fn emit(&self, source: Arc<str>, handle: &'static str, value: ComponentValue) {
            self.events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((source, handle.to_string(), value));
        }
    }
}
