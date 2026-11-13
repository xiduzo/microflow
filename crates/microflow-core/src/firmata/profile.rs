//! The board pin profile — what each pin of the connected board can do.
//!
//! A Firmata pin number is positional and means something different on every
//! board: analog channel 0 (`A0`) is pin 14 on an Uno, 54 on a Mega 2560 and
//! 18 on a Leonardo, and PWM sits on different pins again. The board says so
//! itself, in its `CAPABILITY_RESPONSE` (the modes each pin supports) and its
//! `ANALOG_MAPPING_RESPONSE` (the analog channel each pin reads). A
//! [`PinProfile`] is those two answers, held once and asked everywhere:
//!
//! - the codec decodes an `ANALOG_MESSAGE` for channel `n` onto
//!   [`analog_pin(n)`](PinProfile::analog_pin) and encodes `REPORT_ANALOG` with
//!   [`analog_channel(pin)`](PinProfile::analog_channel);
//! - both hosts project it into the [`PinInfo`] seed
//!   ([`pin_infos`](PinProfile::pin_infos)), and the runtime rebuilds it from
//!   that seed ([`from_pin_infos`](PinProfile::from_pin_infos)), modes included;
//! - nodes resolve an `"A<n>"` pin label with [`resolve`](PinProfile::resolve)
//!   and ask [`supports`](PinProfile::supports) whether a pin has a mode.
//!
//! An empty profile means "no board described yet" (a runtime with no board, a
//! test). Every question then answers *unknown* rather than *no*, and an
//! `"A<n>"` label falls back to the Uno layout (`14 + n`) the codec assumed
//! before boards were described.

use super::{
    Mode, MODE_ANALOG, MODE_I2C, MODE_INPUT, MODE_OUTPUT, MODE_PULLUP, MODE_PWM, MODE_SERVO,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Firmata pin of analog channel 0 on the Uno / Nano — the fallback for an
/// `"A<n>"` label when no board has described its pins.
pub const UNO_FIRST_ANALOG_PIN: u8 = 14;

/// The capability-response terminator for one pin.
const END_OF_PIN: u8 = 127;

/// One pin's entry in the seed both hosts hand the runtime, and the pin list
/// the UI shows. `analogChannel` is the analog channel the pin reads (`A0` =
/// 0), or `-1` when the pin is not an analog input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PinInfo {
    #[ts(type = "number")]
    pub pin: usize,
    #[serde(default)]
    pub supported_modes: Vec<u8>,
    pub analog_channel: i32,
}

/// What one pin can do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PinCaps {
    /// The `(mode, resolution)` pairs from the capability response.
    pub modes: Vec<Mode>,
    /// The analog channel this pin reads, if it is an analog input.
    pub analog_channel: Option<u8>,
}

impl PinCaps {
    #[must_use]
    pub fn has_mode(&self, mode: u8) -> bool {
        self.modes.iter().any(|m| m.mode == mode)
    }
}

/// A pin as a node names it: a Firmata pin number, or an analog channel label
/// (`"A0"`) that only the board can turn into a pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinLabel {
    Pin(u8),
    Analog(u8),
}

impl PinLabel {
    /// `"A3"` / `"a3"` → `Analog(3)`; `"17"` → `Pin(17)`; anything else `None`.
    #[must_use]
    pub fn parse(label: &str) -> Option<Self> {
        let label = label.trim();
        match label.strip_prefix(['A', 'a']) {
            Some(channel) => channel.parse().ok().map(Self::Analog),
            None => label.parse().ok().map(Self::Pin),
        }
    }
}

impl std::fmt::Display for PinLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pin(pin) => write!(f, "pin {pin}"),
            Self::Analog(channel) => write!(f, "A{channel}"),
        }
    }
}

/// The board's pins and what each can do. See the module docs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PinProfile {
    pins: Vec<PinCaps>,
    /// Analog channel → pin, the hot lookup of every `ANALOG_MESSAGE`.
    channel_pins: Vec<Option<u8>>,
}

impl PinProfile {
    /// A profile of `pins`, indexed by Firmata pin number.
    #[must_use]
    pub fn new(pins: Vec<PinCaps>) -> Self {
        let mut profile = Self { pins, channel_pins: Vec::new() };
        profile.index_channels();
        profile
    }

    /// Decode a `CAPABILITY_RESPONSE` body (the bytes between the command and
    /// `END_SYSEX`): `(mode, resolution)` pairs, each pin closed by `127`.
    /// Analog channels are numbered in pin order among the pins advertising
    /// ANALOG, which is what `StandardFirmata` reports; an analog mapping
    /// response, when it arrives, overrides them
    /// ([`apply_analog_mapping`](Self::apply_analog_mapping)).
    #[must_use]
    pub fn from_capability_response(body: &[u8]) -> Self {
        let mut pins = Vec::new();
        let mut current = PinCaps::default();
        let mut i = 0;
        while i < body.len() {
            if body[i] == END_OF_PIN {
                pins.push(std::mem::take(&mut current));
                i += 1;
                continue;
            }
            let resolution = body.get(i + 1).copied().unwrap_or(0);
            current.modes.push(Mode { mode: body[i], resolution });
            i += 2;
        }
        // A frame cut before its last `127` still described that pin.
        if !current.modes.is_empty() {
            pins.push(current);
        }
        let mut channel = 0u8;
        for pin in &mut pins {
            if pin.has_mode(MODE_ANALOG) {
                pin.analog_channel = Some(channel);
                channel = channel.saturating_add(1);
            }
        }
        Self::new(pins)
    }

    /// Apply an `ANALOG_MAPPING_RESPONSE` body: one byte per pin, the analog
    /// channel it reads or `127` for none. A mapping longer than the profile
    /// (its capability response was lost) adds pins of unknown modes.
    pub fn apply_analog_mapping(&mut self, body: &[u8]) {
        if self.pins.len() < body.len() {
            self.pins.resize_with(body.len(), PinCaps::default);
        }
        for (pin, &channel) in self.pins.iter_mut().zip(body) {
            pin.analog_channel = (channel != END_OF_PIN).then_some(channel);
        }
        self.index_channels();
    }

    /// Rebuild a profile from the hosts' [`PinInfo`] seed.
    ///
    /// Accepts the projection hosts sent before boards were described, where
    /// `analogChannel` carried the *pin index*: when every analog entry equals
    /// its own pin and none is pin 0 (no real board numbers its first analog
    /// channel after its own pin), the values are renumbered in pin order.
    #[must_use]
    pub fn from_pin_infos(infos: &[PinInfo]) -> Self {
        let len = infos.iter().map(|p| p.pin + 1).max().unwrap_or(0);
        let mut pins = vec![PinCaps::default(); len];
        let analog: Vec<&PinInfo> = infos.iter().filter(|p| p.analog_channel >= 0).collect();
        let legacy = !analog.is_empty()
            && analog.iter().all(|p| p.analog_channel as usize == p.pin && p.pin > 0);
        let mut ranked: Vec<usize> = analog.iter().map(|p| p.pin).collect();
        ranked.sort_unstable();
        for info in infos {
            let caps = &mut pins[info.pin];
            caps.modes = info.supported_modes.iter().map(|&mode| Mode { mode, resolution: 0 }).collect();
            caps.analog_channel = match info.analog_channel {
                c if c < 0 => None,
                _ if legacy => ranked.iter().position(|&p| p == info.pin).map(|r| r as u8),
                c => u8::try_from(c).ok(),
            };
        }
        Self::new(pins)
    }

    /// The seed both hosts hand the runtime (and the UI's pin list).
    #[must_use]
    pub fn pin_infos(&self) -> Vec<PinInfo> {
        self.pins
            .iter()
            .enumerate()
            .map(|(pin, caps)| PinInfo {
                pin,
                supported_modes: caps.modes.iter().map(|m| m.mode).collect(),
                analog_channel: caps.analog_channel.map_or(-1, i32::from),
            })
            .collect()
    }

    /// Number of Firmata pins the board described (0 = no board described).
    #[must_use]
    pub fn len(&self) -> usize {
        self.pins.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.pins.is_empty()
    }

    #[must_use]
    pub fn caps(&self, pin: u8) -> Option<&PinCaps> {
        self.pins.get(pin as usize)
    }

    /// The analog channel `pin` reads, if it is an analog input.
    #[must_use]
    pub fn analog_channel(&self, pin: u8) -> Option<u8> {
        self.caps(pin)?.analog_channel
    }

    /// The pin that reads analog channel `channel`. With no board described,
    /// the Uno layout (`14 + channel`).
    #[must_use]
    pub fn analog_pin(&self, channel: u8) -> Option<u8> {
        if self.channel_pins.is_empty() {
            return UNO_FIRST_ANALOG_PIN.checked_add(channel);
        }
        self.channel_pins.get(channel as usize).copied().flatten()
    }

    /// How many analog inputs the board has.
    #[must_use]
    pub fn analog_count(&self) -> usize {
        self.channel_pins.iter().flatten().count()
    }

    /// The Firmata pin a node's label names: `A<n>` through the board's analog
    /// mapping, a plain number as is. `None` for an `A<n>` the board lacks.
    #[must_use]
    pub fn resolve(&self, label: PinLabel) -> Option<u8> {
        match label {
            PinLabel::Pin(pin) => Some(pin),
            PinLabel::Analog(channel) => self.analog_pin(channel),
        }
    }

    /// [`resolve`](Self::resolve) for a label as stored in node data; an
    /// unparseable or unknown label reads as `fallback`.
    #[must_use]
    pub fn resolve_label(&self, label: &str, fallback: u8) -> u8 {
        PinLabel::parse(label).and_then(|l| self.resolve(l)).unwrap_or(fallback)
    }

    /// Whether `pin` supports Firmata `mode`: `None` when the board has not
    /// described its modes (empty profile, or a seed without modes),
    /// `Some(false)` for a pin past the board's last pin.
    #[must_use]
    pub fn supports(&self, pin: u8, mode: u8) -> Option<bool> {
        if !self.pins.iter().any(|p| !p.modes.is_empty()) {
            return None;
        }
        Some(self.caps(pin).is_some_and(|caps| caps.has_mode(mode)))
    }

    /// `A0`..`A<n>` as text, for messages: `"A0–A5"`.
    #[must_use]
    pub fn analog_range(&self) -> Option<String> {
        match self.analog_count() {
            0 => None,
            1 => Some("A0".to_string()),
            n => Some(format!("A0–A{}", n - 1)),
        }
    }

    fn index_channels(&mut self) {
        self.channel_pins.clear();
        for (pin, caps) in self.pins.iter().enumerate() {
            if let Some(channel) = caps.analog_channel {
                let channel = channel as usize;
                if self.channel_pins.len() <= channel {
                    self.channel_pins.resize(channel + 1, None);
                }
                self.channel_pins[channel].get_or_insert(pin as u8);
            }
        }
    }
}

/// A Firmata mode's name, for messages ("PWM", "servo").
#[must_use]
pub fn mode_name(mode: u8) -> &'static str {
    match mode {
        MODE_INPUT => "digital input",
        MODE_OUTPUT => "digital output",
        MODE_ANALOG => "analog input",
        MODE_PWM => "PWM",
        MODE_SERVO => "servo",
        MODE_I2C => "I2C",
        MODE_PULLUP => "pull-up input",
        _ => "this mode",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(pin: usize, modes: &[u8], analog_channel: i32) -> PinInfo {
        PinInfo { pin, supported_modes: modes.to_vec(), analog_channel }
    }

    #[test]
    fn capability_response_closes_every_pin_and_adds_none_after_the_last() {
        let body = [MODE_INPUT, 1, MODE_OUTPUT, 1, 127, MODE_ANALOG, 10, 127, 127];
        let profile = PinProfile::from_capability_response(&body);
        assert_eq!(profile.len(), 3);
        assert!(profile.caps(0).unwrap().has_mode(MODE_OUTPUT));
        assert_eq!(profile.analog_channel(1), Some(0));
        assert!(profile.caps(2).unwrap().modes.is_empty());
    }

    #[test]
    fn analog_mapping_overrides_the_counted_channels() {
        let mut profile = PinProfile::from_capability_response(&[MODE_ANALOG, 10, 127, MODE_ANALOG, 10, 127]);
        profile.apply_analog_mapping(&[3, 127]);
        assert_eq!(profile.analog_pin(3), Some(0));
        assert_eq!(profile.analog_pin(0), None);
        assert_eq!(profile.analog_channel(1), None);
    }

    #[test]
    fn labels_resolve_through_the_board() {
        let mut caps = vec![PinCaps::default(); 70];
        for (channel, pin) in (54..70).enumerate() {
            caps[pin].analog_channel = Some(channel as u8);
        }
        let mega = PinProfile::new(caps);
        assert_eq!(mega.resolve_label("A0", 0), 54);
        assert_eq!(mega.resolve_label("a15", 0), 69);
        assert_eq!(mega.resolve_label("13", 0), 13);
        assert_eq!(mega.resolve(PinLabel::Analog(16)), None);
        assert_eq!(mega.analog_range().as_deref(), Some("A0–A15"));
        // No board described: the Uno layout.
        assert_eq!(PinProfile::default().resolve_label("A2", 0), 16);
    }

    #[test]
    fn supports_is_unknown_until_the_board_lists_modes() {
        let unknown = PinProfile::from_pin_infos(&[info(0, &[], -1), info(1, &[], 0)]);
        assert_eq!(unknown.supports(0, MODE_PWM), None);
        let known = PinProfile::from_pin_infos(&[info(0, &[], -1), info(1, &[MODE_OUTPUT, MODE_PWM], -1)]);
        assert_eq!(known.supports(1, MODE_PWM), Some(true));
        assert_eq!(known.supports(0, MODE_OUTPUT), Some(false));
        assert_eq!(known.supports(9, MODE_OUTPUT), Some(false), "past the last pin");
    }

    #[test]
    fn seed_round_trips_and_reads_the_old_pin_index_projection() {
        let infos = vec![info(0, &[MODE_INPUT], -1), info(1, &[MODE_ANALOG], 0), info(2, &[MODE_ANALOG], 1)];
        assert_eq!(PinProfile::from_pin_infos(&infos).pin_infos(), infos);

        let legacy: Vec<PinInfo> = (0..20).map(|p| info(p, &[], if p >= 14 { p as i32 } else { -1 })).collect();
        let profile = PinProfile::from_pin_infos(&legacy);
        assert_eq!(profile.analog_pin(0), Some(14));
        assert_eq!(profile.analog_channel(19), Some(5));
    }
}
