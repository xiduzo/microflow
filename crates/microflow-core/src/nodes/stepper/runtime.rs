//! Stepper Motor Component - Output
//!
//! Controls stepper motors via Firmata's `AccelStepper` protocol (sysex `0x62`).
//! Supports step/direction driver boards (A4988, DRV8825, TMC2209, `EasyDriver`)
//! as well as 2-wire and 4-wire H-bridge configurations.
//!
//! ## Lifecycle
//! 1. `initialize()` — Sends config, speed, and acceleration sysex messages.
//! 2. `dispatch("value", steps)` — Relative move by N steps.
//! 3. `dispatch("to", position)` — Absolute move to position.
//! 4. `dispatch("stop", _)` — Stop with deceleration.
//! 5. `dispatch("zero", _)` — Reset position counter.
//! 6. `dispatch("enable", on)` — Hold the motor (truthy) or release it (falsy).
//!
//! The Stepper declares no Emit. Where the motor is, and when a move is
//! done, only the board knows: `AccelStepperFirmata` reports it in
//! move-complete / position-report sysex replies, which no Hardware Callback
//! decodes yet (it would mirror `on_pin_change` / `on_i2c_reply`). A position
//! counted from the moves sent would be wrong as soon as a move is cut short
//! (`stop`) or a relative move arrives mid-move (the board moves relative to
//! where the motor is, not to where it was heading). Its outputs come with
//! that callback, in the runtime and the sketch together.

use crate::firmata::FirmwareFeature;
use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, DiagnosticLevel,
    HardwareComponent, RuntimeContext, RuntimeError,
};

use super::config::{StepperConfig, StepperInterface};

/// `AccelStepper` sysex command byte
const ACCELSTEPPER_DATA: u8 = 0x62;

/// `AccelStepper` sub-commands
const CMD_CONFIG: u8 = 0x00;
const CMD_ZERO: u8 = 0x01;
const CMD_STEP: u8 = 0x02;
const CMD_TO: u8 = 0x03;
const CMD_ENABLE: u8 = 0x04;
const CMD_STOP: u8 = 0x05;
const CMD_SET_ACCEL: u8 = 0x08;
const CMD_SET_SPEED: u8 = 0x09;

/// The largest step count (either way) `AccelStepperFirmata` can take: it
/// decodes 28 bits of magnitude (4 × 7), so a bigger move would wrap silently
/// on the board. Moves are clamped to it.
pub(crate) const MAX_STEPS: i32 = (1 << 28) - 1;

pub(crate) struct Stepper {
    base: ComponentBase,
    config: StepperConfig,
    /// A move was clamped to [`MAX_STEPS`] and the node says so; the next move
    /// in range clears it.
    clamp_shown: bool,
}

impl Stepper {
    #[must_use]
    pub(crate) fn new(id: String, config: StepperConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            clamp_shown: false,
        }
    }

    /// A requested step count or position, clamped to what the board can take
    /// ([`MAX_STEPS`]); a clamp warns on the node, the next move in range
    /// clears it. A non-number reads as 0.
    fn steps_in_range(&mut self, requested: f64, ctx: &mut RuntimeContext) -> i32 {
        let max = f64::from(MAX_STEPS);
        if requested.abs() > max {
            ctx.report_diagnostic(
                DiagnosticLevel::Warning,
                format!(
                    "A move to {requested} steps is past what the board can take; it moves {} steps instead (the limit is ±{MAX_STEPS})",
                    requested.clamp(-max, max) as i32
                ),
            );
            self.clamp_shown = true;
        } else if self.clamp_shown {
            ctx.clear_diagnostic();
            self.clamp_shown = false;
        }
        requested.clamp(-max, max) as i32
    }

    /// Send a sysex message for the `AccelStepper` protocol.
    fn send_sysex(&self, ctx: &mut RuntimeContext, data: Vec<u8>) -> Result<(), RuntimeError> {
        ctx.board().sysex(ACCELSTEPPER_DATA, &data)?;
        Ok(())
    }

    /// Build the config sysex message and send it.
    fn send_config(&self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let interface_byte = match self.config.interface {
            StepperInterface::Driver => 0b0010000u8,   // 001XXXX = driver
            StepperInterface::TwoWire => 0b0100000u8,  // 010XXXX = two wire
            StepperInterface::FourWire => 0b1000000u8,  // 100XXXX = four wire
        };

        // Add enable pin bit if present
        let interface_byte = if self.config.enable_pin.is_some() {
            interface_byte | 0x01
        } else {
            interface_byte
        };

        let mut data = vec![
            CMD_CONFIG,
            self.config.device_num,
            interface_byte,
        ];

        // Append pins based on interface type
        match self.config.interface {
            StepperInterface::Driver => {
                data.push(self.config.step_pin);
                data.push(self.config.dir_pin);
            }
            StepperInterface::TwoWire => {
                data.push(self.config.motor_pin1);
                data.push(self.config.motor_pin2);
            }
            StepperInterface::FourWire => {
                data.push(self.config.motor_pin1);
                data.push(self.config.motor_pin2);
                data.push(self.config.motor_pin3);
                data.push(self.config.motor_pin4);
            }
        }

        if let Some(enable_pin) = self.config.enable_pin {
            data.push(enable_pin);
        }

        self.send_sysex(ctx, data)
    }

    /// Encode a float into `AccelStepper`'s custom 4-byte format, as firmata.js
    /// `encodeCustomFloat` does: value = significand × 10^(exponent − 11), with a
    /// 23-bit significand (bytes 0..2 + the low two bits of byte 3), the 4-bit
    /// biased exponent in byte 3 bits 2..5 and the sign in byte 3 bit 6. The
    /// decimal point is shifted right while a fraction remains, so 1.5 travels
    /// as 15 × 10⁻¹ rather than being truncated to 1.
    fn encode_custom_float(value: f32) -> [u8; 4] {
        const MAX_SIGNIFICAND: f64 = 8_388_608.0; // 2^23
        if value == 0.0 || !value.is_finite() {
            return [0, 0, 0, 0];
        }
        let sign = u8::from(value < 0.0);
        let mut significand = f64::from(value.abs());
        let mut exponent: i32 = 0;
        while significand.fract() > 1e-6 && significand * 10.0 < MAX_SIGNIFICAND && exponent > -11 {
            significand *= 10.0;
            exponent -= 1;
        }
        while significand >= MAX_SIGNIFICAND && exponent < 4 {
            significand /= 10.0;
            exponent += 1;
        }
        let significand = (significand.round() as u32).min(0x7F_FFFF);
        let exp_bits = ((exponent + 11) as u8) & 0x0F;
        [
            (significand & 0x7F) as u8,
            ((significand >> 7) & 0x7F) as u8,
            ((significand >> 14) & 0x7F) as u8,
            ((significand >> 21) & 0x03) as u8 | (exp_bits << 2) | (sign << 6),
        ]
    }

    /// Encode a signed step count the way `AccelStepperFirmata` decodes it
    /// (firmata.js `encode32BitSignedInteger`): **sign-magnitude**, the
    /// magnitude in 4 × 7 bits and the sign in bit 3 of the fifth byte. Two's
    /// complement here turned a 50-step move backwards into a move of ~268
    /// million steps. The magnitude is clamped to [`MAX_STEPS`], so the fifth
    /// byte's low bits stay clear and `i32::MIN` cannot go out as −0.
    fn encode_signed_long(value: i32) -> [u8; 5] {
        let value = value.clamp(-MAX_STEPS, MAX_STEPS);
        let magnitude = value.unsigned_abs();
        let mut out = [
            (magnitude & 0x7F) as u8,
            ((magnitude >> 7) & 0x7F) as u8,
            ((magnitude >> 14) & 0x7F) as u8,
            ((magnitude >> 21) & 0x7F) as u8,
            ((magnitude >> 28) & 0x07) as u8,
        ];
        if value < 0 {
            out[4] |= 0x08;
        }
        out
    }

    /// Send set-speed sysex.
    fn send_speed(&self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let encoded = Self::encode_custom_float(self.config.speed);
        self.send_sysex(ctx, vec![
            CMD_SET_SPEED,
            self.config.device_num,
            encoded[0], encoded[1], encoded[2], encoded[3],
        ])
    }

    /// Send set-acceleration sysex.
    fn send_acceleration(&self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if self.config.acceleration <= 0.0 {
            return Ok(());
        }
        let encoded = Self::encode_custom_float(self.config.acceleration);
        self.send_sysex(ctx, vec![
            CMD_SET_ACCEL,
            self.config.device_num,
            encoded[0], encoded[1], encoded[2], encoded[3],
        ])
    }

    /// Relative move by N steps.
    pub(crate) fn step(&mut self, ctx: &mut RuntimeContext, steps: i32) -> Result<(), RuntimeError> {
        let encoded = Self::encode_signed_long(steps);
        self.send_sysex(ctx, vec![
            CMD_STEP,
            self.config.device_num,
            encoded[0], encoded[1], encoded[2], encoded[3], encoded[4],
        ])
    }

    /// Absolute move to position.
    pub(crate) fn move_to(&mut self, ctx: &mut RuntimeContext, position: i32) -> Result<(), RuntimeError> {
        let encoded = Self::encode_signed_long(position);
        self.send_sysex(ctx, vec![
            CMD_TO,
            self.config.device_num,
            encoded[0], encoded[1], encoded[2], encoded[3], encoded[4],
        ])
    }

    /// Stop the motor (decelerates if acceleration is set).
    pub(crate) fn stop(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.send_sysex(ctx, vec![CMD_STOP, self.config.device_num])
    }

    /// Make where the motor is now position zero on the board.
    pub(crate) fn zero(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.send_sysex(ctx, vec![CMD_ZERO, self.config.device_num])
    }

    /// Hold the motor (`true`) or release it (`false`): the driver's enable
    /// pin when one is configured, and the coils of a wired motor.
    pub(crate) fn enable(&mut self, ctx: &mut RuntimeContext, state: bool) -> Result<(), RuntimeError> {
        self.send_sysex(ctx, vec![
            CMD_ENABLE,
            self.config.device_num,
            u8::from(state),
        ])
    }
}

impl Component for Stepper {
    fn ports() -> &'static [&'static str] { &["value", "to", "stop", "zero", "enable"] }

    // No `emits()`: see the module docs.

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Stepper" }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> { Some(self) }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "value" => {
                // Relative move: number of steps
                let steps = self.steps_in_range(args.as_number().unwrap_or(0.0), ctx);
                if steps != 0 {
                    self.step(ctx, steps)?;
                }
                Ok(())
            }
            "to" => {
                // Absolute move: target position
                let position = self.steps_in_range(args.as_number().unwrap_or(0.0), ctx);
                self.move_to(ctx, position)?;
                Ok(())
            }
            "stop" => self.stop(ctx),
            "zero" => self.zero(ctx),
            // Truthy holds the motor, falsy releases it: the same test the
            // sketch makes on its `enable` input.
            "enable" => self.enable(ctx, args.is_truthy()),
            _ => Err(RuntimeError::ComponentError(
                format!("Stepper: unknown method '{method}'")
            )),
        }
    }
}

impl HardwareComponent for Stepper {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        log::info!(
            "Stepper {} initialize: device={}, step_pin={}, dir_pin={}, speed={}, accel={}",
            self.base.id, self.config.device_num, self.config.step_pin,
            self.config.dir_pin, self.config.speed, self.config.acceleration
        );

        // 0. Stock firmware ignores AccelStepper sysex: say so instead.
        ctx.board().require_firmware(FirmwareFeature::AccelStepper)?;
        // 1. Send stepper config (pins, interface type)
        self.send_config(ctx)?;
        // 2. Set max speed
        self.send_speed(ctx)?;
        // 3. Set acceleration (if non-zero)
        self.send_acceleration(ctx)?;
        // 4. Enable driver if enable pin is configured
        if self.config.enable_pin.is_some() {
            self.enable(ctx, true)?;
        }

        Ok(())
    }
}

impl ComponentBuilder for Stepper {
    type Config = StepperConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod sim_tests {
    use crate::firmata::sim::rig::{node, SimRig};
    use crate::firmata::sim::{BoardLayout, Extension, SimBoard, StepperInterface};
    use serde_json::json;

    fn stepper(data: serde_json::Value) -> SimRig {
        let board = SimBoard::new(BoardLayout::uno()).with_extension(Extension::AccelStepper);
        let mut rig = SimRig::connect(board);
        rig.apply_flow(vec![node("motor", "Stepper", data)], vec![]);
        rig
    }

    fn position(rig: &SimRig) -> i32 {
        rig.board.stepper(0).expect("configured").position
    }

    #[test]
    fn initialize_configures_a_driver_with_speed_and_acceleration() {
        let rig = stepper(json!({ "stepPin": 4, "dirPin": 5, "speed": 200, "acceleration": 100 }));
        let m = rig.board.stepper(0).expect("configured");
        assert_eq!(m.interface, StepperInterface::Driver);
        assert_eq!(m.pins, vec![4, 5]);
        assert!((m.max_speed - 200.0).abs() < 1e-3, "speed {}", m.max_speed);
        assert!((m.acceleration - 100.0).abs() < 1e-3, "accel {}", m.acceleration);
        assert!(rig.board.violations().is_empty(), "{:?}", rig.board.violations());
    }

    #[test]
    fn four_wire_config_carries_all_four_pins_and_the_enable_pin() {
        let rig = stepper(json!({
            "interface": "four_wire",
            "motorPin1": 8, "motorPin2": 9, "motorPin3": 10, "motorPin4": 11,
            "enablePin": 12,
        }));
        let m = rig.board.stepper(0).expect("configured");
        assert_eq!(m.interface, StepperInterface::FourWire);
        assert_eq!(m.pins, vec![8, 9, 10, 11, 12]);
        assert!(m.has_enable_pin && m.enabled);
    }

    /// A relative move backwards was sent in two's complement, which
    /// `AccelStepperFirmata` reads as sign-magnitude: −50 became −268 435 406.
    #[test]
    fn relative_moves_go_both_ways() {
        let mut rig = stepper(json!({}));
        rig.dispatch("motor", "value", 100.0);
        rig.pump();
        assert_eq!(position(&rig), 100);
        rig.dispatch("motor", "value", -150.0);
        rig.pump();
        assert_eq!(position(&rig), -50);
    }

    #[test]
    fn absolute_move_zero_stop_and_enable() {
        let mut rig = stepper(json!({ "enablePin": 7 }));
        rig.dispatch("motor", "to", -2_000_000.0);
        rig.pump();
        assert_eq!(position(&rig), -2_000_000);
        rig.dispatch("motor", "zero", true);
        assert_eq!(position(&rig), 0);
        rig.dispatch("motor", "to", 40.0);
        rig.dispatch("motor", "stop", true);
        rig.pump();
        assert_eq!(position(&rig), 0, "stop before the move ran");
        rig.dispatch("motor", "enable", 0.0);
        assert!(!rig.board.stepper(0).expect("configured").enabled);
    }

    /// The Stepper passes nothing on: no move, `zero`, `stop` or `enable`
    /// gives an event an edge could carry.
    #[test]
    fn a_stepper_passes_nothing_on() {
        let mut rig = stepper(json!({ "enablePin": 7 }));
        rig.take_events();
        rig.dispatch("motor", "value", 100.0);
        rig.dispatch("motor", "to", -40.0);
        rig.dispatch("motor", "zero", true);
        rig.dispatch("motor", "stop", true);
        rig.dispatch("motor", "enable", false);
        rig.pump();
        let out: Vec<_> = rig.events().iter().filter(|e| &*e.source == "motor").collect();
        assert!(out.is_empty(), "{out:?}");
        assert!(<super::Stepper as crate::runtime::Component>::emits().is_empty());
    }

    /// `enable` holds the motor for a truthy value and releases it for a falsy
    /// one. The sketch decides on the same truth (`codegen.rs`), so a negative
    /// number holds the motor on the board and live alike.
    #[test]
    fn enable_follows_the_truth_of_what_arrives() {
        use crate::runtime::ComponentValue;

        let mut rig = stepper(json!({ "enablePin": 7 }));
        let cases = [
            (ComponentValue::Bool(false), false),
            (ComponentValue::Bool(true), true),
            (ComponentValue::Number(0.0), false),
            (ComponentValue::Number(1.0), true),
            (ComponentValue::String(String::new()), false),
            (ComponentValue::Number(-1.0), true),
        ];
        for (value, held) in cases {
            rig.dispatch("motor", "enable", value.clone());
            assert_eq!(rig.board.stepper(0).expect("configured").enabled, held, "enable = {value:?}");
        }
    }

    /// A move past the 28 bits `AccelStepperFirmata` decodes wrapped silently;
    /// it is clamped and the node warns until a move in range.
    #[test]
    fn a_move_past_28_bits_is_clamped_and_warned() {
        let mut rig = stepper(json!({}));
        rig.dispatch("motor", "to", 1e12);
        rig.pump();
        assert_eq!(position(&rig), super::MAX_STEPS);
        let warning = rig.diagnostics().last().expect("warned").clone();
        assert_eq!(warning.level, crate::runtime::DiagnosticLevel::Warning);
        assert!(warning.message.as_deref().is_some_and(|m| m.contains("268435455")), "{warning:?}");

        rig.dispatch("motor", "to", f64::from(i32::MIN));
        rig.pump();
        assert_eq!(position(&rig), -super::MAX_STEPS, "i32::MIN must not go out as -0");

        rig.dispatch("motor", "to", 10.0);
        rig.pump();
        assert_eq!(position(&rig), 10);
        assert_eq!(rig.diagnostics().last().and_then(|d| d.message.clone()), None, "an in-range move clears it");
    }

    #[test]
    fn the_encoder_keeps_the_fifth_byte_to_the_sign() {
        assert_eq!(super::Stepper::encode_signed_long(i32::MAX), [0x7F, 0x7F, 0x7F, 0x7F, 0x00]);
        assert_eq!(super::Stepper::encode_signed_long(i32::MIN), [0x7F, 0x7F, 0x7F, 0x7F, 0x08]);
    }

    /// The custom float kept only the integer part above 1 (1.5 → 1) and put
    /// the sign in the exponent's top bit.
    #[test]
    fn fractional_speed_survives_the_custom_float() {
        let rig = stepper(json!({ "speed": 1.5, "acceleration": 0.25 }));
        let m = rig.board.stepper(0).expect("configured");
        assert!((m.max_speed - 1.5).abs() < 1e-6, "speed {}", m.max_speed);
        assert!((m.acceleration - 0.25).abs() < 1e-6, "accel {}", m.acceleration);
    }
}
