//! microflow-core — the platform-independent core shared by the microflow
//! desktop app and (via WebAssembly) the browser.
//!
//! Today this is the Flow read-model ([`flow`]) and the Arduino code generator
//! ([`codegen`]) — pure functions with no Tauri, IO, async, or clock
//! dependencies, so the crate compiles identically for native and `wasm32`
//! targets. The desktop `app_lib` crate re-exports these modules, so it remains
//! the single source of truth with no logic duplicated across platforms.

// Carried over from the desktop crate where codegen previously lived: the
// generator uses intentional casts and simple APIs that don't benefit from
// exhaustive doc sections or `try_from` ceremony.
#![allow(
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::unreadable_literal,
    clippy::too_many_lines,
    clippy::struct_field_names,
    clippy::unnecessary_wraps,
    clippy::needless_pass_by_value,
    clippy::trivially_copy_pass_by_ref,
    clippy::unused_self,
    clippy::match_same_arms,
    clippy::needless_continue,
    clippy::format_push_string,
    clippy::manual_let_else
)]

pub mod bringup;
pub mod codegen;
pub mod config;
pub mod firmata;
pub mod flasher;
pub mod flow;

/// The live flow runtime (executor, router, component nodes). Gated behind the
/// `runtime` feature so codegen-only consumers stay lean; the desktop bin and
/// the browser `microflow-runtime-wasm` crate enable it.
#[cfg(feature = "runtime")]
pub mod runtime;
