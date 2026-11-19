//! RGB LED Component — Output. Template port for the workflow node fan-out.

use crate::firmata::PinProfile;
use crate::runtime::{
    analog_write_like_arduino, pin_mode, Component, ComponentBase, ComponentBuilder,
    ComponentValue, HardwareComponent, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

use super::config::RgbConfig;


#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RgbaColor {
    pub(crate) r: u8,
    pub(crate) g: u8,
    pub(crate) b: u8,
    pub(crate) a: f64,
}

impl Default for RgbaColor {
    fn default() -> Self {
        Self { r: 0, g: 0, b: 0, a: 1.0 }
    }
}

impl From<RgbaColor> for ComponentValue {
    fn from(c: RgbaColor) -> Self {
        ComponentValue::Rgba { r: c.r, g: c.g, b: c.b, a: c.a }
    }
}

pub(crate) struct Rgb {
    base: ComponentBase,
    config: RgbConfig,
    color: RgbaColor,
    /// Per channel (red, green, blue): whether the board has PWM on its pin
    /// (`bind_pins`; `None` = unknown, treated as PWM). A channel without PWM
    /// stays a digital OUTPUT and rounds like Arduino's `analogWrite`.
    has_pwm: [Option<bool>; 3],
}

impl Rgb {
    #[must_use]
    pub(crate) fn new(id: String, config: RgbConfig) -> Self {
        Self {
            base: ComponentBase::new(id, RgbaColor::default().into()),
            config,
            color: RgbaColor::default(),
            has_pwm: [None; 3],
        }
    }

    fn red(&mut self, ctx: &mut RuntimeContext, value: u8) -> Result<(), RuntimeError> {
        self.color.r = value;
        self.update_hardware(ctx)
    }

    fn green(&mut self, ctx: &mut RuntimeContext, value: u8) -> Result<(), RuntimeError> {
        self.color.g = value;
        self.update_hardware(ctx)
    }

    fn blue(&mut self, ctx: &mut RuntimeContext, value: u8) -> Result<(), RuntimeError> {
        self.color.b = value;
        self.update_hardware(ctx)
    }

    fn alpha(&mut self, ctx: &mut RuntimeContext, value: f64) -> Result<(), RuntimeError> {
        self.color.a = (value / 100.0).clamp(0.0, 1.0);
        self.update_hardware(ctx)
    }

    fn off(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.color = RgbaColor::default();
        self.update_hardware(ctx)
    }

    fn update_hardware(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let (r, g, b) = self.apply_intensity();
        let (r, g, b) = self.apply_anode(r, g, b);
        for ((pin, level), has_pwm) in self.channel_pins().into_iter().zip([r, g, b]).zip(self.has_pwm) {
            analog_write_like_arduino(ctx.board(), pin, level, has_pwm)?;
        }
        self.base.set_value(self.color.clone().into());
        Ok(())
    }

    fn channel_pins(&self) -> [u8; 3] {
        [self.config.pins.red, self.config.pins.green, self.config.pins.blue]
    }

    fn apply_intensity(&self) -> (u8, u8, u8) {
        (
            (f64::from(self.color.r) * self.color.a) as u8,
            (f64::from(self.color.g) * self.color.a) as u8,
            (f64::from(self.color.b) * self.color.a) as u8,
        )
    }

    fn apply_anode(&self, r: u8, g: u8, b: u8) -> (u8, u8, u8) {
        if self.config.is_anode {
            (255 - r, 255 - g, 255 - b)
        } else {
            (r, g, b)
        }
    }
}

impl Component for Rgb {
    fn ports() -> &'static [&'static str] {
        &["red", "green", "blue", "alpha", "off"]
    }

    fn emits() -> &'static [&'static str] {
        &[ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Rgb"
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "red" => self.red(ctx, args.as_u8().unwrap_or(0)),
            "green" => self.green(ctx, args.as_u8().unwrap_or(0)),
            "blue" => self.blue(ctx, args.as_u8().unwrap_or(0)),
            "alpha" => self.alpha(ctx, args.as_number().unwrap_or(100.0)),
            "off" => self.off(ctx),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl HardwareComponent for Rgb {
    fn bind_pins(&mut self, pins: &PinProfile) {
        self.has_pwm = self.channel_pins().map(|pin| pins.supports(pin, pin_mode::PWM));
    }

    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        for (pin, has_pwm) in self.channel_pins().into_iter().zip(self.has_pwm) {
            let mode = if has_pwm == Some(false) { pin_mode::OUTPUT } else { pin_mode::PWM };
            ctx.board().set_pin_mode(pin, mode)?;
        }
        self.off(ctx)
    }
}

impl ComponentBuilder for Rgb {
    type Config = RgbConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod sim_tests {
    use crate::firmata::sim::rig::{node, SimRig};
    use crate::firmata::sim::{BoardLayout, SimBoard};
    use serde_json::json;

    fn rgb(is_anode: bool) -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(
            vec![node(
                "rgb",
                "Rgb",
                json!({ "pins": { "red": 9, "green": 10, "blue": 11 }, "isAnode": is_anode }),
            )],
            vec![],
        );
        rig
    }

    fn duty(rig: &SimRig) -> (Option<u16>, Option<u16>, Option<u16>) {
        (rig.board.pin(9).pwm(), rig.board.pin(10).pwm(), rig.board.pin(11).pwm())
    }

    #[test]
    fn channels_and_alpha_set_pwm_duty() {
        let mut rig = rgb(false);
        assert_eq!(duty(&rig), (Some(0), Some(0), Some(0)), "starts off");
        rig.dispatch("rgb", "red", 200.0);
        rig.dispatch("rgb", "blue", 100.0);
        assert_eq!(duty(&rig), (Some(200), Some(0), Some(100)));
        rig.dispatch("rgb", "alpha", 50.0);
        assert_eq!(duty(&rig), (Some(100), Some(0), Some(50)));
        rig.dispatch("rgb", "off", true);
        assert_eq!(duty(&rig), (Some(0), Some(0), Some(0)));
        assert!(rig.board.violations().is_empty(), "{:?}", rig.board.violations());
    }

    /// `off` darkens the LED and forgets the colour and its intensity; the LED
    /// stays dark until a channel is sent a value again.
    #[test]
    fn off_holds_until_a_channel_is_sent_again() {
        let mut rig = rgb(false);
        rig.dispatch("rgb", "red", 200.0);
        rig.dispatch("rgb", "alpha", 50.0);
        rig.dispatch("rgb", "off", true);
        assert_eq!(duty(&rig), (Some(0), Some(0), Some(0)));
        rig.dispatch("rgb", "green", 80.0);
        assert_eq!(duty(&rig), (Some(0), Some(80), Some(0)), "red and the 50% are gone");
    }

    /// A channel on a pin without PWM (12 on an Uno) rounds like
    /// `analogWrite`: on from 128.
    #[test]
    fn a_channel_without_pwm_switches_at_128() {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(
            vec![node("rgb", "Rgb", json!({ "pins": { "red": 9, "green": 10, "blue": 12 } }))],
            vec![],
        );
        rig.dispatch("rgb", "blue", 200.0);
        assert!(rig.board.pin(12).is_high());
        rig.dispatch("rgb", "blue", 100.0);
        assert!(!rig.board.pin(12).is_high());
        assert!(rig.board.violations().is_empty(), "{:?}", rig.board.violations());
    }

    #[test]
    fn common_anode_inverts_every_channel() {
        let mut rig = rgb(true);
        assert_eq!(duty(&rig), (Some(255), Some(255), Some(255)), "off = all high");
        rig.dispatch("rgb", "green", 55.0);
        assert_eq!(duty(&rig), (Some(255), Some(200), Some(255)));
    }
}
