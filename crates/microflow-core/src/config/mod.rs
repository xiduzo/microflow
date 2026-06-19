//! Per-Node configuration types — the single source of truth shared by the live
//! runtime (interpret) and the codegen emitters (compile to C++).
//!
//! A Node's config (its fields, defaults, and config-only enums) used to live
//! inside its `runtime/<category>/<node>.rs` file, behind the `runtime` cargo
//! feature. Codegen — which is ungated, so the lean `microflow-codegen-wasm`
//! build stays free of the runtime's deps — could not reach those types, so each
//! emitter re-read `node.data` with hand-typed field names and duplicated default
//! literals (`f64_or_default(node, "attenuation", 0.995)`). That duplication
//! drifted: see commit `e1e1eb9` (Smooth) and the `usize`/`u16` window-size
//! mismatch it left behind.
//!
//! These types now live here, **ungated**, so both sides deserialize `node.data`
//! into the same struct. The default `0.995` exists once; the live `Smooth`
//! Component and the `emit_smooth` template can no longer disagree about what a
//! Node means. The runtime `<node>.rs` files re-export their config from here, so
//! their `Component` impls and tests are unchanged.
//!
//! Flat namespace (one module per Node) on purpose: the runtime and codegen
//! category trees diverge (`Constant`/`Interval` sit under `generator/` in the
//! runtime but `control/` in codegen), so neither tree is a safe parent here.

pub mod serde_utils;

// input
pub mod button;
pub mod hotkey;
pub mod motion;
pub mod switch;

// output
pub mod led;
pub mod piezo;
pub mod pixel;
pub mod relay;
pub mod servo;
pub mod stepper;

// generator / control
pub mod constant;
pub mod delay;
pub mod interval;
pub mod oscillator;
pub mod trigger;

// transformation
pub mod calculate;
pub mod compare;
pub mod gate;
pub mod range_map;
pub mod smooth;
