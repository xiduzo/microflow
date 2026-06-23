//! Cloud nodes (`Mqtt`, `Llm`, `Figma`) on the [`Component`] trait.
//!
//! These nodes are **sans-IO** (ADR-0009): a `dispatch` records a `CloudRequest`
//! into the turn's `Effects` instead of spawning network work. The host's
//! `EffectsSink::perform_cloud` performs the call (desktop: `rumqttc` for MQTT/
//! Figma, `reqwest` for LLM; browser: `fetch`/WSS); any result re-enters via
//! `FlowRuntime::inject_event` on the node's output handles. The nodes therefore
//! pull no tokio/reqwest/mqtt dependencies and live in `microflow-core` — gated
//! behind the `cloud` feature — so **both** hosts register them from one place
//! (`ComponentRegistry::register_all`) and the browser wasm build can run them.
//! They are unit-tested by asserting the recorded request (see
//! [`test_support::recorded_cloud_requests`]) rather than by spying on a service.
//!
//! [`Component`]: crate::runtime::Component

pub mod figma;
pub mod llm;
pub mod mqtt;

#[cfg(test)]
pub(crate) mod test_support {
    use crate::firmata::FirmataClient;
    use crate::runtime::{BufferBoardWriter, CloudRequestKind, RuntimeContext, ScheduleRequests};

    /// Build a throwaway [`RuntimeContext`] and run `f` with it. Cloud nodes
    /// ignore the board / clock, so the discarded buffer + client are just there
    /// to satisfy the borrow.
    pub fn with_test_ctx<R>(node_id: &str, f: impl FnOnce(&mut RuntimeContext) -> R) -> R {
        let mut client = FirmataClient::new();
        let mut out = Vec::new();
        let mut writer = BufferBoardWriter::new(&mut client, &mut out);
        let mut reqs = ScheduleRequests::default();
        let mut ctx = RuntimeContext::new(&mut writer, 0.0, node_id, &mut reqs);
        f(&mut ctx)
    }

    /// Run `f` with a throwaway [`RuntimeContext`] and return the
    /// [`CloudRequestKind`]s it recorded via `ctx.request_cloud` — the sans-IO
    /// assertion surface for cloud nodes (ADR-0009): dispatch, then assert the
    /// emitted request instead of spying on a recording service.
    pub fn recorded_cloud_requests(
        node_id: &str,
        f: impl FnOnce(&mut RuntimeContext),
    ) -> Vec<CloudRequestKind> {
        let mut client = FirmataClient::new();
        let mut out = Vec::new();
        let mut writer = BufferBoardWriter::new(&mut client, &mut out);
        let mut reqs = ScheduleRequests::default();
        {
            let mut ctx = RuntimeContext::new(&mut writer, 0.0, node_id, &mut reqs);
            f(&mut ctx);
        }
        reqs.cloud_requests.into_iter().map(|(_, kind)| kind).collect()
    }
}
