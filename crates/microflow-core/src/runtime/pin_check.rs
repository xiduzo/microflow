//! Live pin check — a node on a pin the connected board cannot use the way the
//! node needs gets a diagnostic on its badge, instead of silently doing
//! nothing (`StandardFirmata` ignores a mode a pin lacks, and every write that
//! depends on it).
//!
//! The *requirements* are not written here: which pins a node uses and what
//! for is the one table [`pin_demands`] that sketch validation reads too. This
//! module only judges those demands against the board's real [`PinProfile`]:
//!
//! - a pin the board does not have, or cannot use for the node at all (servo
//!   on a non-servo pin, analog read on a digital-only pin, an `A<n>` past the
//!   board's last analog input) → **Error**: the node will not work;
//! - a brightness (`analogWrite`) on a pin without PWM → **Warning**: the node
//!   works, rounded to on/off as Arduino's `analogWrite` does.
//!
//! With no board described (an empty profile) nothing is judged. The verdict
//! goes into the runtime's health ledger (`health::NodeHealth::pin_fault`), so
//! it is a [`DiagnosticOrigin::Runtime`](crate::runtime::DiagnosticOrigin)
//! diagnostic, cleared when a rebuild (a new pin, a new board) fixes it.

use crate::codegen::validate::{pin_demands, PinDemand, PinUse};
use crate::firmata::{PinProfile, MODE_INPUT, MODE_OUTPUT, MODE_PWM, MODE_SERVO};
use crate::flow::{FlowEdge, FlowNode};
use crate::runtime::DiagnosticLevel;

/// The first pin problem `node` has on this board: any error before any
/// warning.
pub(crate) fn problem(
    node: &FlowNode,
    edges: &[FlowEdge],
    pins: &PinProfile,
) -> Option<(DiagnosticLevel, String)> {
    if pins.is_empty() {
        return None;
    }
    let mut warning = None;
    for demand in pin_demands(node, edges) {
        match judge(&demand, pins) {
            Some((DiagnosticLevel::Error, message)) => return Some((DiagnosticLevel::Error, message)),
            Some((level, message)) => {
                warning.get_or_insert((level, message));
            }
            None => {}
        }
    }
    warning
}

fn judge(demand: &PinDemand, pins: &PinProfile) -> Option<(DiagnosticLevel, String)> {
    let error = |message: String| Some((DiagnosticLevel::Error, message));
    let analog_inputs = || {
        pins.analog_range()
            .map_or_else(|| "this board has no analog inputs".to_string(), |r| format!("use one of {r}"))
    };
    let pin = match (demand.pin, pins.resolve(demand.pin)) {
        (_, Some(pin)) => pin,
        (label, None) => return error(format!("{label} is not on this board — {}", analog_inputs())),
    };
    let name = if demand.field.is_empty() {
        format!("Pin {pin}")
    } else {
        format!("The {} pin {pin}", demand.field)
    };
    if pin as usize >= pins.len() {
        return error(format!("{name} is not on this board (its pins are 0–{})", pins.len() - 1));
    }
    match demand.uses {
        PinUse::Digital => (pins.supports(pin, MODE_OUTPUT) == Some(false)
            && pins.supports(pin, MODE_INPUT) == Some(false))
        .then(|| (DiagnosticLevel::Error, format!("{name} cannot be used as a digital pin on this board"))),
        PinUse::Servo => (pins.supports(pin, MODE_SERVO) == Some(false))
            .then(|| (DiagnosticLevel::Error, format!("{name} cannot drive a servo on this board"))),
        PinUse::AnalogIn => (pins.analog_count() > 0 && pins.analog_channel(pin).is_none()).then(|| {
            (DiagnosticLevel::Error, format!("{name} cannot read analog values on this board — {}", analog_inputs()))
        }),
        PinUse::Pwm => (pins.supports(pin, MODE_PWM) == Some(false)).then(|| {
            (
                DiagnosticLevel::Warning,
                format!("{name} has no PWM on this board, so brightness is rounded to on/off (on from 128)"),
            )
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmata::sim::rig::{edge, node, SimRig};
    use crate::firmata::sim::{BoardLayout, SimBoard};
    use crate::runtime::DiagnosticOrigin;
    use serde_json::json;

    fn badge(rig: &SimRig, id: &str) -> Option<(DiagnosticLevel, Option<String>)> {
        let last = rig.diagnostics().iter().rev().find(|d| d.node == id)?;
        assert_eq!(last.origin, DiagnosticOrigin::Runtime, "the runtime judged the pin");
        Some((last.level, last.message.clone()))
    }

    fn rig(layout: BoardLayout) -> SimRig {
        SimRig::connect(SimBoard::new(layout))
    }

    #[test]
    fn servo_on_a_pin_without_servo_is_an_error_until_moved() {
        let mut rig = rig(BoardLayout::uno());
        rig.apply_flow(vec![node("s", "Servo", json!({ "pin": 14 }))], vec![]);
        let (level, message) = badge(&rig, "s").expect("badged");
        assert_eq!(level, DiagnosticLevel::Error);
        assert!(message.unwrap().contains("Pin 14 cannot drive a servo"));

        rig.apply_flow(vec![node("s", "Servo", json!({ "pin": 9 }))], vec![]);
        assert_eq!(badge(&rig, "s"), Some((DiagnosticLevel::Error, None)), "moving the servo clears it");
    }

    #[test]
    fn analog_read_on_a_digital_pin_and_a_missing_channel_are_errors() {
        let mut rig = rig(BoardLayout::uno());
        rig.apply_flow(
            vec![
                node("digital", "Sensor", json!({ "pin": 7 })),
                node("a9", "Potentiometer", json!({ "pin": "A9" })),
                node("ok", "Sensor", json!({ "pin": "A5" })),
            ],
            vec![],
        );
        let digital = badge(&rig, "digital").unwrap().1.unwrap();
        assert!(digital.contains("Pin 7 cannot read analog values") && digital.contains("A0–A5"), "{digital}");
        assert!(badge(&rig, "a9").unwrap().1.unwrap().contains("A9 is not on this board"));
        assert_eq!(badge(&rig, "ok"), None);
    }

    #[test]
    fn a_pin_past_the_board_is_an_error() {
        let mut rig = rig(BoardLayout::uno());
        rig.apply_flow(vec![node("led", "Led", json!({ "pin": 40 }))], vec![]);
        assert!(badge(&rig, "led").unwrap().1.unwrap().contains("Pin 40 is not on this board (its pins are 0–19)"));
        // The same pin is fine on a Mega.
        let mut mega = SimRig::connect(SimBoard::new(BoardLayout::mega2560()));
        mega.apply_flow(vec![node("led", "Led", json!({ "pin": 40 }))], vec![]);
        assert_eq!(badge(&mega, "led"), None);
    }

    #[test]
    fn wired_brightness_on_a_pin_without_pwm_is_a_warning() {
        let mut rig = rig(BoardLayout::uno());
        rig.apply_flow(
            vec![node("k", "Constant", json!({ "value": 200 })), node("led", "Led", json!({ "pin": 13 }))],
            vec![edge("k", "value", "led", "value")],
        );
        let (level, message) = badge(&rig, "led").expect("badged");
        assert_eq!(level, DiagnosticLevel::Warning);
        assert!(message.unwrap().contains("Pin 13 has no PWM"));
        // Unwired, the Led only switches on and off: nothing to say.
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(vec![node("led", "Led", json!({ "pin": 13 }))], vec![]);
        assert_eq!(badge(&rig, "led"), None);
    }

    #[test]
    fn rgb_names_the_channel_without_pwm() {
        let mut rig = rig(BoardLayout::uno());
        rig.apply_flow(
            vec![node("rgb", "Rgb", json!({ "pins": { "red": 9, "green": 10, "blue": 12 } }))],
            vec![],
        );
        let (level, message) = badge(&rig, "rgb").expect("badged");
        assert_eq!(level, DiagnosticLevel::Warning);
        assert!(message.unwrap().contains("The blue pin 12 has no PWM"));
    }

    #[test]
    fn the_uno_serial_pins_are_not_digital_pins() {
        let mut rig = rig(BoardLayout::uno());
        rig.apply_flow(vec![node("btn", "Button", json!({ "pin": 0 }))], vec![]);
        assert!(badge(&rig, "btn").unwrap().1.unwrap().contains("Pin 0 cannot be used as a digital pin"));
    }

    #[test]
    fn no_board_described_judges_nothing() {
        let pins = PinProfile::default();
        let servo = node("s", "Servo", json!({ "pin": 99 }));
        assert_eq!(problem(&servo, &[], &pins), None);
    }
}
