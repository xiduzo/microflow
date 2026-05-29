//! Board-target abstraction for the Sketch Generation context.
//!
//! A [`BoardTarget`] describes, for one supported Arduino-family board, the
//! hardware facts codegen and (later) validation need: a stable identifier, a
//! human-readable name, the board's pin map, which pins drive PWM, which pins
//! are analog inputs, the available timers, and the board's capabilities.
//!
//! This is **pure data plus a lookup**. It is deliberately independent from the
//! `flasher` board abstraction (`flasher/boards.rs`, `flasher/types.rs`), which
//! models flashing protocols and USB product IDs rather than codegen pin and
//! capability facts. The identifiers here stay aligned with
//! `flasher::commands::get_supported_boards` (lowercase, e.g. `uno`, `nano`)
//! where they overlap, so the two schemes do not diverge.
//!
//! ## Invariants
//!
//! - Every PWM-capable pin and every analog-input pin referenced by a target
//!   exists in that target's pin map.
//! - Identifiers in the supported-target list are unique.
//!
//! These are enforced by construction (the registry is built from data tables)
//! and asserted by tests.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A capability a board may offer, against which a Node can declare a
/// requirement. Membership is the check: a board satisfies a requirement iff
/// the capability is present in its [`BoardTarget::capabilities`] set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub enum BoardCapability {
    /// On-board networking (`WiFi` / `TCP-IP`), e.g. the ESP32.
    Networking,
}

/// One logical pin in a board's pin map.
///
/// `number` is how the pin is addressed in the generated Sketch (the value an
/// emitter writes into `pinMode`/`digitalWrite`). `pwm` and `analog_input`
/// record the pin's hardware abilities so a target can answer which pins drive
/// PWM and which are analog inputs without per-board code branches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct BoardPin {
    /// The pin number as addressed in the generated Sketch.
    pub number: u8,
    /// Whether this pin supports PWM output (`analogWrite`).
    pub pwm: bool,
    /// Whether this pin is an analog input.
    pub analog_input: bool,
}

/// A supported board target: the consistency boundary for one board's pin and
/// capability facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct BoardTarget {
    /// Stable identifier, aligned with the flasher's lowercase board ids where
    /// they overlap (e.g. `uno`, `nano`, `esp32`).
    pub id: String,
    /// Human-readable name presented to the Flow Author (e.g. `Arduino Uno`).
    pub name: String,
    /// The board's pin map.
    pub pins: Vec<BoardPin>,
    /// Available hardware timers, by name (e.g. `Timer0`).
    pub timers: Vec<String>,
    /// Capabilities this board offers.
    pub capabilities: Vec<BoardCapability>,
}

impl BoardTarget {
    /// The pin numbers that support PWM output.
    #[must_use]
    pub fn pwm_pins(&self) -> Vec<u8> {
        self.pins.iter().filter(|p| p.pwm).map(|p| p.number).collect()
    }

    /// The pin numbers that are analog inputs.
    #[must_use]
    pub fn analog_input_pins(&self) -> Vec<u8> {
        self.pins
            .iter()
            .filter(|p| p.analog_input)
            .map(|p| p.number)
            .collect()
    }

    /// True when this board offers `capability` — the membership check a Node
    /// requirement is resolved against.
    #[must_use]
    pub fn offers(&self, capability: BoardCapability) -> bool {
        self.capabilities.contains(&capability)
    }
}

/// Build the Uno target. Digital pins 0-13 plus analog A0-A5 (numbered 14-19).
/// PWM on 3, 5, 6, 9, 10, 11 (matches the `ATmega328P` Uno).
fn uno() -> BoardTarget {
    BoardTarget {
        id: "uno".to_string(),
        name: "Arduino Uno".to_string(),
        pins: atmega328p_pins(),
        timers: vec!["Timer0".to_string(), "Timer1".to_string(), "Timer2".to_string()],
        capabilities: vec![],
    }
}

/// Build the Nano target. Same `ATmega328P` pin map as the Uno.
fn nano() -> BoardTarget {
    BoardTarget {
        id: "nano".to_string(),
        name: "Arduino Nano".to_string(),
        pins: atmega328p_pins(),
        timers: vec!["Timer0".to_string(), "Timer1".to_string(), "Timer2".to_string()],
        capabilities: vec![],
    }
}

/// The shared `ATmega328P` pin map used by Uno and Nano.
fn atmega328p_pins() -> Vec<BoardPin> {
    let pwm = [3u8, 5, 6, 9, 10, 11];
    let mut pins: Vec<BoardPin> = (0u8..=13)
        .map(|number| BoardPin {
            number,
            pwm: pwm.contains(&number),
            analog_input: false,
        })
        .collect();
    // Analog inputs A0-A5 are addressed as 14-19 in the generated Sketch.
    pins.extend((14u8..=19).map(|number| BoardPin {
        number,
        pwm: false,
        analog_input: true,
    }));
    pins
}

/// Build the ESP32 target. A representative subset of the dev-kit GPIO map:
/// most GPIOs drive PWM (LEDC), GPIO32-39 back the ADC1 analog inputs, and the
/// board offers networking.
fn esp32() -> BoardTarget {
    // Input-only ADC1 pins (no PWM output).
    let analog_only = [34u8, 35, 36, 39];
    // A representative set of output-capable GPIOs (all PWM-capable via LEDC).
    let pwm_gpios = [2u8, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];

    let mut pins: Vec<BoardPin> = pwm_gpios
        .iter()
        .map(|&number| BoardPin {
            number,
            pwm: true,
            // GPIO32/33 belong to ADC1 and are analog-capable.
            analog_input: number == 32 || number == 33,
        })
        .collect();
    pins.extend(analog_only.iter().map(|&number| BoardPin {
        number,
        pwm: false,
        analog_input: true,
    }));
    pins.sort_by_key(|p| p.number);

    BoardTarget {
        id: "esp32".to_string(),
        name: "ESP32".to_string(),
        pins,
        timers: vec![
            "Timer0".to_string(),
            "Timer1".to_string(),
            "Timer2".to_string(),
            "Timer3".to_string(),
        ],
        capabilities: vec![BoardCapability::Networking],
    }
}

/// All supported board targets, in a stable order suitable for presenting in
/// the editor. At minimum includes Uno, Nano, and ESP32.
#[must_use]
pub fn supported_targets() -> Vec<BoardTarget> {
    vec![uno(), nano(), esp32()]
}

/// Retrieve a single board target by its identifier, or `None` if no supported
/// target uses that id. The lookup validation and generation consult.
#[must_use]
pub fn target_by_id(id: &str) -> Option<BoardTarget> {
    supported_targets().into_iter().find(|t| t.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Scenario: Supported boards are available to choose from.
    /// Given the supported targets include Uno, Nano, and ESP32, when the list
    /// is opened, then each is presented with its name.
    #[test]
    fn supported_targets_include_uno_nano_esp32_with_names() {
        let targets = supported_targets();
        let ids: Vec<&str> = targets.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"uno"));
        assert!(ids.contains(&"nano"));
        assert!(ids.contains(&"esp32"));
        // Each target is presented with a non-empty human-readable name.
        assert!(targets.iter().all(|t| !t.name.is_empty()));
    }

    #[test]
    fn target_by_id_retrieves_known_and_rejects_unknown() {
        assert_eq!(target_by_id("uno").map(|t| t.name), Some("Arduino Uno".to_string()));
        assert!(target_by_id("not-a-board").is_none());
    }

    /// Scenario: A board target describes its pins and capabilities.
    /// Given the Uno target, when its hardware facts are inspected, then it
    /// reports its PWM pins, analog-input pins, and the capabilities it offers.
    #[test]
    fn uno_reports_pwm_analog_and_capabilities() {
        let uno = target_by_id("uno").expect("uno is supported");

        // Uno PWM pins on the ATmega328P.
        let pwm = uno.pwm_pins();
        for expected in [3u8, 5, 6, 9, 10, 11] {
            assert!(pwm.contains(&expected), "Uno pin {expected} should be PWM");
        }

        // Six analog inputs A0-A5 (addressed 14-19).
        let analog = uno.analog_input_pins();
        assert_eq!(analog.len(), 6, "Uno has six analog inputs");

        // Capabilities are inspectable; the Uno offers no networking.
        assert!(!uno.offers(BoardCapability::Networking));
    }

    /// Scenario: A networking-capable board is distinguishable.
    /// Given the ESP32 and Uno targets, when their capabilities are compared,
    /// then the ESP32 offers networking and the Uno does not.
    #[test]
    fn esp32_offers_networking_and_uno_does_not() {
        let esp32 = target_by_id("esp32").expect("esp32 is supported");
        let uno = target_by_id("uno").expect("uno is supported");

        assert!(esp32.offers(BoardCapability::Networking));
        assert!(!uno.offers(BoardCapability::Networking));
    }

    /// Invariant: every PWM-capable and analog-input pin exists in the pin map,
    /// and identifiers in the supported list are unique.
    #[test]
    fn targets_satisfy_pin_and_uniqueness_invariants() {
        let targets = supported_targets();

        // Unique identifiers.
        let mut seen = HashSet::new();
        for t in &targets {
            assert!(seen.insert(t.id.clone()), "duplicate board id: {}", t.id);
        }

        // Every PWM/analog pin is present in the pin map (trivially true given
        // pins are the source, but guards against a future refactor where the
        // sets diverge). Asserts the helper-derived sets are subsets of the map.
        for t in &targets {
            let map: HashSet<u8> = t.pins.iter().map(|p| p.number).collect();
            for pin in t.pwm_pins() {
                assert!(map.contains(&pin), "{}: PWM pin {pin} absent from pin map", t.id);
            }
            for pin in t.analog_input_pins() {
                assert!(map.contains(&pin), "{}: analog pin {pin} absent from pin map", t.id);
            }
        }
    }
}
