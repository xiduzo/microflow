//! Value and event types carried through the flow runtime.
//!
//! These are the wire-compatible shapes the browser reactor and the desktop
//! frontend both consume. The serde representation here is the single source of
//! truth for the `ComponentValue` / `ComponentEvent` JSON; the desktop crate's
//! `ts-rs` bindings (generated from its mirror types until Stage 4) describe the
//! same shape, so the bytes match on both platforms.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Value that a component can hold.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ComponentValue {
    Bool(bool),
    Number(f64),
    String(String),
    Rgba { r: u8, g: u8, b: u8, a: f64 },
    Array(Vec<ComponentValue>),
}

impl Default for ComponentValue {
    fn default() -> Self {
        ComponentValue::Number(0.0)
    }
}

impl From<bool> for ComponentValue {
    fn from(v: bool) -> Self {
        ComponentValue::Bool(v)
    }
}

impl From<f64> for ComponentValue {
    fn from(v: f64) -> Self {
        ComponentValue::Number(v)
    }
}

impl From<i32> for ComponentValue {
    fn from(v: i32) -> Self {
        ComponentValue::Number(f64::from(v))
    }
}

impl From<u8> for ComponentValue {
    fn from(v: u8) -> Self {
        ComponentValue::Number(f64::from(v))
    }
}

impl ComponentValue {
    /// Convert any `ComponentValue` to a boolean (truthy/falsy check).
    /// - Bool: direct value
    /// - Number: true if non-zero
    /// - String: true if non-empty
    /// - Rgba: always true (color exists)
    /// - Array: true if non-empty
    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        Some(match self {
            ComponentValue::Bool(v) => *v,
            ComponentValue::Number(v) => *v != 0.0,
            ComponentValue::String(v) => !v.is_empty(),
            ComponentValue::Rgba { .. } => true,
            ComponentValue::Array(v) => !v.is_empty(),
        })
    }

    /// Check if the value is truthy (convenience method that never returns None).
    #[must_use]
    pub fn is_truthy(&self) -> bool {
        self.as_bool().unwrap_or(false)
    }

    #[must_use]
    pub fn as_number(&self) -> Option<f64> {
        match self {
            ComponentValue::Number(v) => Some(*v),
            ComponentValue::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_u8(&self) -> Option<u8> {
        self.as_number().map(|v| v.clamp(0.0, 255.0) as u8)
    }
}

/// Event emitted by a component.
///
/// `Serialize`-only: the frontend consumes these (via the desktop
/// `component-event` Tauri event, or the browser reactor's `Effects`), never
/// sends them back. `Arc<str>` fields stay cheap to clone during fanout.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEvent {
    pub source: Arc<str>,
    pub source_handle: Arc<str>,
    pub value: ComponentValue,
    pub edge_id: Option<String>,
    /// Flow version when the event was created (stale-gating).
    pub sequence: u64,
}

/// Pin configuration for components.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
pub enum PinConfig {
    Single(u8),
    Named(String),
    Multiple(Vec<u8>),
    Rgb { red: u8, green: u8, blue: u8 },
    Matrix { data: u8, clock: u8, cs: u8 },
}

impl PinConfig {
    #[allow(dead_code)]
    #[must_use]
    pub fn as_single(&self) -> Option<u8> {
        match self {
            PinConfig::Single(p) => Some(*p),
            _ => None,
        }
    }
}

impl Default for PinConfig {
    fn default() -> Self {
        PinConfig::Single(13)
    }
}
