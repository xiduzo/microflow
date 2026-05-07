//! Per-impl wiring spec returned from `Component::listener_wiring()`.
//!
//! Replaces the instance-name `match` block formerly in
//! `FlowRuntime::register_component_pin_listener`. See `CONTEXT.md` § Wiring.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListenerWiring {
    /// Digital pin reporting. Component receives `pin_change` calls on bool transitions.
    DigitalPin { pin: u8 },
    /// Analog pin reporting. Component receives `pin_change` calls when value drift >= threshold.
    AnalogPin { pin: u8, threshold: u16 },
    /// I2C device by 7-bit address. Component receives `i2c_reply` calls.
    I2cAddress { address: u8 },
    /// Keyboard hotkey. Stored lowercased to match dispatch lookup.
    HotKey { accelerator: String },
}
