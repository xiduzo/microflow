//! Firmware features beyond `StandardFirmata` — what a node needs from the
//! board's firmware, and whether the board's capability response says it has
//! it.
//!
//! A board without an extension ignores its sysex in silence, so a Pixel or
//! Stepper node on stock firmware looks like it runs while nothing on the board
//! moves. Firmware that has the extension advertises a pin mode for it on every
//! digital pin of its `CAPABILITY_RESPONSE`, which the detection handshake
//! already reads and both hosts seed into the runtime (`supportedModes`):
//!
//! - Microflow's `StandardFirmata` (`flasher/hex/StandardFirmata`) writes
//!   `PIXEL_COMMAND` (`0x51`) as a mode on each digital pin.
//! - `ConfigurableFirmata`'s `AccelStepperFirmata::handleCapability` writes
//!   `PIN_MODE_STEPPER` (`0x08`) on each digital pin.

use super::FirmataClient;
use std::fmt;

/// `PIN_MODE_STEPPER`, advertised by `ConfigurableFirmata`'s `AccelStepper`.
pub const PIN_MODE_STEPPER: u8 = 0x08;
/// The pin mode Microflow's `StandardFirmata` advertises for its WS2812 support
/// (it reuses node-pixel's `PIXEL_COMMAND` sysex id).
pub const PIN_MODE_PIXEL: u8 = 0x51;

/// A firmware extension a node depends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirmwareFeature {
    /// WS2812 / NeoPixel strips (sysex `0x51`).
    Pixel,
    /// `AccelStepper` motors (sysex `0x62`).
    AccelStepper,
}

impl FirmwareFeature {
    /// The pin mode firmware with this feature advertises in its capability
    /// response.
    #[must_use]
    pub fn pin_mode(self) -> u8 {
        match self {
            Self::Pixel => PIN_MODE_PIXEL,
            Self::AccelStepper => PIN_MODE_STEPPER,
        }
    }
}

/// What the user sees on the node's badge, after "Could not set up on the
/// board: ".
impl fmt::Display for FirmwareFeature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Pixel => {
                "this board's firmware does not support LED strips. Flash Microflow's \
                 StandardFirmata (see \"Flash firmware manually\")"
            }
            Self::AccelStepper => {
                "this board's firmware does not support stepper motors. Flash \
                 ConfigurableFirmata with AccelStepperFirmata"
            }
        })
    }
}

impl FirmataClient {
    /// Whether the board's firmware has `feature`: `Some(true)` when any pin
    /// advertises its mode, `Some(false)` when the capability table is known
    /// and none does, `None` when there is no capability table to judge by (a
    /// seed without `supportedModes`, or no response yet) — never a false alarm.
    #[must_use]
    pub fn supports(&self, feature: FirmwareFeature) -> Option<bool> {
        if self.pins.iter().all(|p| p.modes.is_empty()) {
            return None;
        }
        let mode = feature.pin_mode();
        Some(self.pins.iter().any(|p| p.modes.iter().any(|m| m.mode == mode)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmata::{Mode, Pin, MODE_INPUT, MODE_OUTPUT};

    fn client(modes: &[u8]) -> FirmataClient {
        let mut c = FirmataClient::new();
        let pin = Pin {
            modes: modes.iter().map(|&mode| Mode { mode, resolution: 1 }).collect(),
            ..Pin::default()
        };
        c.pins = vec![Pin::default(), pin];
        c
    }

    #[test]
    fn a_feature_is_supported_when_any_pin_advertises_its_mode() {
        let c = client(&[MODE_INPUT, MODE_OUTPUT, PIN_MODE_PIXEL]);
        assert_eq!(c.supports(FirmwareFeature::Pixel), Some(true));
        assert_eq!(c.supports(FirmwareFeature::AccelStepper), Some(false));
    }

    #[test]
    fn without_a_capability_table_there_is_no_verdict() {
        assert_eq!(FirmataClient::new().supports(FirmwareFeature::Pixel), None);
        assert_eq!(client(&[]).supports(FirmwareFeature::AccelStepper), None);
    }
}
