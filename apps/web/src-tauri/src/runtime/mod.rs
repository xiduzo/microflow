//! Desktop seam around the shared flow runtime.
//!
//! The live engine is `microflow_core::runtime::FlowRuntime`, owned by the
//! single actor thread in [`host`]. The core runtime is `!Send` (single-threaded
//! `Rc`/`RefCell`), so it lives on its own thread and is driven entirely by
//! `ActorMsg`s. Everything in this module is the desktop-side glue around it:
//!
//! - [`cloud_performer`] — the `CloudPerformer`: publishes the `CloudRequest`s
//!   the sans-IO `Mqtt`/`Figma` nodes record (they live in `microflow-core`,
//!   ADR-0009) and owns the MQTT subscriptions, reconciled against the
//!   runtime's subscriber wirings. The desktop's only cloud-specific code.
//! - [`commands`] — the Tauri commands (`flow_update`, `component_call`, …) that
//!   post `ActorMsg`s to the actor and await its replies.
//! - [`host`] — the actor thread: owns the core `FlowRuntime` + the serial port,
//!   applies each turn's `Effects` via its `EffectsSink` (serial writes,
//!   `component-event` emits, wakeup timers, and cloud calls through the
//!   `CloudPerformer`); cloud results re-enter as `ActorMsg::Inject`.
//! - [`services`] — the `MqttBrokers` Capability Trait the `CloudPerformer`
//!   reaches the broker pool through, and its recording adapter.
//! - [`supervisor`] — the crash-loop guard and panic fingerprint behind the
//!   actor's respawn-on-panic (a turn that panics rebuilds the runtime).
//!
//! The previous desktop-local runtime — its own executor, router, registry,
//! wiring and a full duplicate set of node impls — was removed once the core
//! re-host went live. `microflow-core` is now the single source of truth for
//! flow execution on both desktop and web.

pub mod cloud_performer;
pub mod commands;
pub mod host;
pub mod midi;
pub mod services;
pub mod supervisor;
