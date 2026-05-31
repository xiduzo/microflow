//! Desktop host for the shared `microflow_core::runtime::FlowRuntime`.
//!
//! `core::FlowRuntime` is `!Send` (single-threaded `Rc`/`RefCell`), so it cannot
//! sit in Tauri `State` (needs `Send + Sync`) or behind `Arc<TokioMutex>` the way
//! the desktop's own runtime does. The re-host confines it to a single **actor
//! thread** that also owns the serial port; everything else talks to it over a
//! `Send` `mpsc::Sender<ActorMsg>` kept in `AppState`. Each message maps to one
//! core entry point, whose returned [`Effects`] the actor applies: write
//! `outbound_bytes` to the port, `emit("component-event", …)` per event, arm
//! Tokio timers for `wakeups` (firing `ActorMsg::Wake`), abort them on
//! `cancellations`.
//!
//! This module currently owns the two pieces that are unit-testable in
//! isolation and that lock the design:
//! - [`ActorMsg`] — the message contract the actor loop consumes.
//! - [`register_cloud_nodes`] — injects the desktop's cloud nodes (mqtt/llm/
//!   figma) into a runtime via `FlowRuntime::register_node`, with factory
//!   closures capturing the live services. This is the "desktop-only cloud"
//!   seam: the async/network impls stay here, core stays dependency-lean.
//! - [`ChannelEmitter`] — the [`CloudEmitter`] impl that forwards async
//!   results back to the actor as [`ActorMsg::Inject`].
//!
//! The actor loop itself + `apply_effects` + the raw-bytes serial transport land
//! in the re-host finale (they need the live port + `AppHandle` and are gated on
//! the desktop hardware smoke test), replacing `board/{handle,protocol,receipt,
//! io_loop}` and the `lib.rs` event thread.
//!
//! [`Effects`]: microflow_core::runtime::Effects

use crate::runtime::cloud::{self, CloudEmitter};
use crate::runtime::services::{LlmRegistry, MqttPublisher};
use microflow_core::runtime::{Component, ComponentValue, FlowRuntime, RuntimeError};
use serde::Deserialize;
use std::sync::mpsc::Sender;
use std::sync::Arc;

/// A message the actor thread processes; each carries only `Send` data and maps
/// to one `FlowRuntime` entry point.
pub enum ActorMsg {
    /// A board connected: seed the codec's pin table (`FirmataSession.pinsJson`
    /// shape) and take ownership of the open port for raw read/write.
    Connect {
        port: Box<dyn serialport::SerialPort>,
        pins_json: String,
    },
    /// The board disconnected: drop the port, keep the flow state.
    Disconnect,
    /// A flow update (`flow_update` command) — core `FlowUpdate` JSON.
    FlowUpdate(serde_json::Value),
    /// An external component call (`component_call` command).
    Call {
        id: String,
        method: String,
        value: ComponentValue,
    },
    /// A hotkey press (`key_event`), matched against registered hotkey listeners.
    Key { accelerator: String },
    /// An inbound MQTT / Figma broker payload routed to a subscribe component.
    Deliver {
        id: String,
        topic: String,
        payload: Vec<u8>,
    },
    /// An async cloud-node result re-entering the runtime (the `CloudEmitter`
    /// path) — folded in via `FlowRuntime::inject_event`.
    Inject {
        source: Arc<str>,
        handle: String,
        value: ComponentValue,
    },
    /// A host timer fired: deliver `method` to `node_id` via `FlowRuntime::wake`.
    Wake { node_id: String, method: String },
    /// Tear the actor down (app exit).
    Shutdown,
}

/// [`CloudEmitter`] that forwards a cloud node's async result to the actor as an
/// [`ActorMsg::Inject`], so it re-enters the `!Send` runtime on the owner thread.
pub struct ChannelEmitter {
    tx: Sender<ActorMsg>,
}

impl ChannelEmitter {
    #[must_use]
    pub fn new(tx: Sender<ActorMsg>) -> Self {
        Self { tx }
    }
}

impl CloudEmitter for ChannelEmitter {
    fn emit(&self, source: Arc<str>, handle: &'static str, value: ComponentValue) {
        let _ = self.tx.send(ActorMsg::Inject {
            source,
            handle: handle.to_string(),
            value,
        });
    }
}

/// Inject the desktop's cloud nodes into `runtime`'s registry. The factory
/// closures capture the live `MqttManager` publish handle / `LlmRegistry`, the
/// Tokio runtime handle (to spawn publish/generation), and the [`CloudEmitter`]
/// (LLM async results). Keeps the async/network impls in the desktop crate so
/// `microflow-core` pulls no tokio/reqwest/mqtt dependencies.
pub fn register_cloud_nodes(
    runtime: &mut FlowRuntime,
    mqtt_publisher: Arc<dyn MqttPublisher>,
    llm_registry: Arc<LlmRegistry>,
    rt_handle: Option<tokio::runtime::Handle>,
    emitter: Arc<dyn CloudEmitter>,
) {
    {
        let publisher = Arc::clone(&mqtt_publisher);
        let rt = rt_handle.clone();
        runtime.register_node(
            "Mqtt",
            Box::new(move |id, data| {
                let config = cloud::mqtt::MqttConfig::deserialize(data).map_err(|e| {
                    RuntimeError::ConfigDeserialize {
                        component: "Mqtt".to_string(),
                        source: e,
                    }
                })?;
                Ok(Box::new(cloud::mqtt::Mqtt::new(
                    id,
                    config,
                    Arc::clone(&publisher),
                    rt.clone(),
                )) as Box<dyn Component>)
            }),
        );
    }

    {
        let publisher = Arc::clone(&mqtt_publisher);
        let rt = rt_handle.clone();
        runtime.register_node(
            "Figma",
            Box::new(move |id, data| {
                let config = cloud::figma::FigmaConfig::deserialize(data).map_err(|e| {
                    RuntimeError::ConfigDeserialize {
                        component: "Figma".to_string(),
                        source: e,
                    }
                })?;
                Ok(Box::new(cloud::figma::Figma::new(
                    id,
                    config,
                    Arc::clone(&publisher),
                    rt.clone(),
                )) as Box<dyn Component>)
            }),
        );
    }

    {
        let registry = Arc::clone(&llm_registry);
        let rt = rt_handle.clone();
        let emitter = Arc::clone(&emitter);
        runtime.register_node(
            "Llm",
            Box::new(move |id, data| {
                let config = cloud::llm::LlmConfig::deserialize(data).map_err(|e| {
                    RuntimeError::ConfigDeserialize {
                        component: "Llm".to_string(),
                        source: e,
                    }
                })?;
                Ok(Box::new(cloud::llm::Llm::new(
                    id,
                    config,
                    Arc::clone(&registry),
                    rt.clone(),
                    Some(Arc::clone(&emitter)),
                )) as Box<dyn Component>)
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::cloud::test_support::RecordingCloudEmitter;
    use crate::runtime::services::{RecordedPublish, RecordingMqttPublisher};
    use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
    use std::time::Duration;

    fn node(id: &str, instance: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some(instance.to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn deps() -> (Arc<RecordingMqttPublisher>, Arc<LlmRegistry>, Arc<RecordingCloudEmitter>) {
        (
            Arc::new(RecordingMqttPublisher::new()),
            Arc::new(LlmRegistry::new()),
            Arc::new(RecordingCloudEmitter::new()),
        )
    }

    async fn wait_for_publishes(
        recorder: &RecordingMqttPublisher,
        min: usize,
        timeout: Duration,
    ) -> Vec<RecordedPublish> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let snap = recorder.recorded();
            if snap.len() >= min || tokio::time::Instant::now() >= deadline {
                return snap;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[test]
    fn channel_emitter_forwards_inject() {
        let (tx, rx) = std::sync::mpsc::channel();
        let emitter = ChannelEmitter::new(tx);
        emitter.emit(Arc::from("node-1"), "value", ComponentValue::Number(7.0));

        match rx.recv().expect("a message") {
            ActorMsg::Inject { source, handle, value } => {
                assert_eq!(source.as_ref(), "node-1");
                assert_eq!(handle, "value");
                assert_eq!(value, ComponentValue::Number(7.0));
            }
            _ => panic!("expected Inject"),
        }
    }

    #[tokio::test]
    async fn registered_figma_node_builds_and_publishes_on_dispatch() {
        // End-to-end proof of the registration seam: register → update_flow
        // builds the node from JSON → dispatch drives the captured publisher.
        let (publisher, llm, emitter) = deps();
        let mut rt = FlowRuntime::new();
        register_cloud_nodes(
            &mut rt,
            publisher.clone() as Arc<dyn MqttPublisher>,
            llm,
            Some(tokio::runtime::Handle::current()),
            emitter as Arc<dyn CloudEmitter>,
        );

        rt.update_flow(FlowUpdate {
            nodes: vec![node(
                "fig",
                "Figma",
                serde_json::json!({
                    "brokerId": "broker-1",
                    "uniqueId": "uid-1",
                    "variableId": "VariableID:1:2",
                    "resolvedType": "BOOLEAN",
                }),
            )],
            edges: vec![],
        });

        rt.dispatch("fig", "true", ComponentValue::Bool(true));

        let published = wait_for_publishes(&publisher, 1, Duration::from_secs(1)).await;
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].topic, "microflow/uid-1/app/variable/1-2/set");
        assert_eq!(published[0].payload, b"true");
    }

    #[test]
    fn registers_mqtt_and_llm_without_error() {
        // Smoke: both build from JSON via the registry (no ComponentNotFound).
        let (publisher, llm, emitter) = deps();
        let mut rt = FlowRuntime::new();
        register_cloud_nodes(
            &mut rt,
            publisher as Arc<dyn MqttPublisher>,
            llm,
            None,
            emitter as Arc<dyn CloudEmitter>,
        );

        // Unknown configs would surface as a build error and skip the node; a
        // well-formed update simply drains with no panic.
        rt.update_flow(FlowUpdate {
            nodes: vec![
                node(
                    "m",
                    "Mqtt",
                    serde_json::json!({ "direction": "publish", "brokerId": "b", "topic": "t" }),
                ),
                node(
                    "l",
                    "Llm",
                    serde_json::json!({ "providerId": "p", "model": "m", "prompt": "hi" }),
                ),
            ],
            edges: Vec::<FlowEdge>::new(),
        });
    }
}
