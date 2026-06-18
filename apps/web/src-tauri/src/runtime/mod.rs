//! Desktop seam around the shared flow runtime.
//!
//! The live engine is `microflow_core::runtime::FlowRuntime`, owned by the
//! single actor thread in [`host`]. The core runtime is `!Send` (single-threaded
//! `Rc`/`RefCell`), so it lives on its own thread and is driven entirely by
//! `ActorMsg`s. Everything in this module is the desktop-side glue around it:
//!
//! - [`commands`] — the Tauri commands (`flow_update`, `component_call`, …) that
//!   post `ActorMsg`s to the actor and await its replies.
//! - [`host`] — the actor thread: owns the core `FlowRuntime` + the serial port,
//!   applies each turn's `Effects` (serial writes, `component-event` emits,
//!   wakeup timers), and bridges cloud-node results back in via `CloudEmitter`.
//! - [`cloud`] — the desktop-only `Mqtt`/`Llm`/`Figma` nodes, implemented on
//!   core's `Component` trait and injected with `FlowRuntime::register_node`.
//! - [`services`] — the `MqttPublisher` / `LlmRegistry` handles the cloud
//!   factories capture (and that `flow_update` syncs credentials into).
//!
//! The previous desktop-local runtime — its own executor, router, registry,
//! wiring and a full duplicate set of node impls — was removed once the core
//! re-host went live. `microflow-core` is now the single source of truth for
//! flow execution on both desktop and web.

pub mod cloud;
pub mod commands;
pub mod host;
pub mod services;
