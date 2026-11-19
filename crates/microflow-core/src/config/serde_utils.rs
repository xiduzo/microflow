//! How a number the editor wrote becomes a config field: a whole-number
//! setting, a pin, or an analog pin. Every integer field of every Node config
//! reads through one of these, so the live runtime and the emitted sketch get
//! the same value from the same `data` — or the same refusal.
//!
//! The editor's numeric inputs store JSON numbers, and a number that was
//! dragged, typed or pasted may carry a fraction (`25.2`). The rules:
//!
//! - **A whole-number setting** ([`deserialize_whole`]: a duration, a count, a
//!   frequency, an I2C address, …) takes a JSON number and **rounds it to the
//!   nearest whole number, halves away from zero** (`25.2` → 25, `25.5` → 26).
//!   The rounded value must fit the field (`0..=MAX` of its type); a negative
//!   or too-large value is **refused**, never wrapped or clamped — a delay of
//!   −5 has no nearest meaning the author would recognise.
//! - **A pin** ([`deserialize_pin_u8`]) is a name, not a quantity: `13`,
//!   `13.0` and `"13"` are pin 13; `13.4` is refused.
//! - **An analog pin** ([`deserialize_analog_pin`]) is `"A0"`-style or a pin
//!   number; anything else is refused.
//!
//! A refusal surfaces as an unreadable config (`crate::config::resolve`).
//!
//! Lives under `config` (ungated) rather than `runtime` (gated) so the shared
//! per-Node config structs — consumed by both the runtime and the codegen
//! emitters — can reference these `deserialize_with` helpers without pulling the
//! `runtime` feature into the lean codegen build.

use crate::firmata::PinLabel;
use serde::de::{self, Visitor};
use serde::{Deserialize, Serialize};
use std::marker::PhantomData;

/// An unsigned integer type a whole-number setting can be stored in.
pub trait WholeNumber: Sized {
    /// The largest value the type holds.
    const MAX: u64;
    /// `value` as this type; `None` when it is larger than [`MAX`](Self::MAX).
    fn from_whole(value: u64) -> Option<Self>;
}

impl WholeNumber for u8 {
    const MAX: u64 = u8::MAX as u64;
    fn from_whole(value: u64) -> Option<Self> {
        Self::try_from(value).ok()
    }
}

impl WholeNumber for u16 {
    const MAX: u64 = u16::MAX as u64;
    fn from_whole(value: u64) -> Option<Self> {
        Self::try_from(value).ok()
    }
}

impl WholeNumber for u32 {
    const MAX: u64 = u32::MAX as u64;
    fn from_whole(value: u64) -> Option<Self> {
        Self::try_from(value).ok()
    }
}

impl WholeNumber for u64 {
    const MAX: u64 = u64::MAX;
    fn from_whole(value: u64) -> Option<Self> {
        Some(value)
    }
}

impl WholeNumber for usize {
    const MAX: u64 = usize::MAX as u64;
    fn from_whole(value: u64) -> Option<Self> {
        Self::try_from(value).ok()
    }
}

/// Deserialize a whole-number setting from a JSON number, rounding a fraction
/// to the nearest whole number (halves away from zero). See the module docs.
///
/// # Errors
///
/// When the value is not a number, or its rounded value does not fit `T`.
pub fn deserialize_whole<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: WholeNumber,
{
    struct WholeVisitor<T>(PhantomData<T>);

    impl<T: WholeNumber> WholeVisitor<T> {
        fn fit<E: de::Error>(value: Option<u64>, got: impl std::fmt::Display) -> Result<T, E> {
            value.and_then(T::from_whole).ok_or_else(|| {
                E::custom(format!("expected a whole number from 0 to {}, got {got}", T::MAX))
            })
        }
    }

    impl<T: WholeNumber> Visitor<'_> for WholeVisitor<T> {
        type Value = T;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(formatter, "a whole number from 0 to {}", T::MAX)
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Self::fit(Some(v), v)
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Self::fit(u64::try_from(v).ok(), v)
        }

        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_precision_loss)]
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            let rounded = v.round();
            // The range check comes first, so the cast below neither wraps a
            // negative nor truncates a value past the type.
            let whole = (0.0..=T::MAX as f64).contains(&rounded).then_some(rounded as u64);
            Self::fit(whole, v)
        }
    }

    deserializer.deserialize_any(WholeVisitor(PhantomData))
}

/// A whole-number setting where a field attribute cannot reach: inside a tuple
/// or a vector (a MIDI song note's velocity). Reads as [`deserialize_whole`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Whole<T>(pub T);

impl<'de, T: WholeNumber> Deserialize<'de> for Whole<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserialize_whole(deserializer).map(Self)
    }
}

/// Deserialize a pin from a number or a numeric string to `u8`:
/// `14`, `14.0` and `"14"` are pin 14. A pin is a name, not a quantity, so a
/// number with a fraction (`13.4`) is refused rather than rounded.
///
/// # Errors
///
/// When the value is not a pin number from 0 to 255.
pub fn deserialize_pin_u8<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct PinU8Visitor;

    impl Visitor<'_> for PinU8Visitor {
        type Value = u8;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string or number representing a pin (0-255)")
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            v.parse().map_err(|_| de::Error::custom(format!("invalid pin: {v}")))
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            pin_number(v)
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            pin_number(v)
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            whole_pin_number(v)
        }
    }

    deserializer.deserialize_any(PinU8Visitor)
}

/// An integer as a pin number.
fn pin_number<E: de::Error>(v: impl TryInto<u8> + std::fmt::Display + Copy) -> Result<u8, E> {
    v.try_into().map_err(|_| de::Error::custom(format!("pin out of range: {v}")))
}

/// A JSON float as a pin number: only a whole value names a pin.
#[allow(clippy::cast_possible_truncation)]
fn whole_pin_number<E: de::Error>(v: f64) -> Result<u8, E> {
    if v.fract() != 0.0 {
        return Err(de::Error::custom(format!("invalid pin: {v}")));
    }
    // `as` saturates, so a value past `i64` still fails the range check.
    u8::try_from(v as i64).map_err(|_| de::Error::custom(format!("pin out of range: {v}")))
}

/// [`deserialize_pin_u8`] for a pin a Node may not have (`null` or missing).
///
/// # Errors
///
/// When the value is neither `null` nor a pin number from 0 to 255.
pub fn deserialize_optional_pin_u8<'de, D>(deserializer: D) -> Result<Option<u8>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    struct Pin(#[serde(deserialize_with = "deserialize_pin_u8")] u8);

    Ok(Option::<Pin>::deserialize(deserializer)?.map(|pin| pin.0))
}

/// Deserialize the pin of an analog reader (Sensor family, Proximity): an
/// analog channel label (`"A0"`, what the editor keeps until a pin is picked)
/// or a pin number (`15`, `"15"`). Only the board can turn `A<n>` into a pin,
/// so the label is kept as the Node names it ([`PinLabel`]); both halves
/// resolve it from here.
///
/// # Errors
///
/// When the value is neither an `A<n>` label nor a pin number from 0 to 255.
pub fn deserialize_analog_pin<'de, D>(deserializer: D) -> Result<PinLabel, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct AnalogPinVisitor;

    impl Visitor<'_> for AnalogPinVisitor {
        type Value = PinLabel;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an analog pin like \"A0\" or a pin number (0-255)")
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            PinLabel::parse(v).ok_or_else(|| de::Error::custom(format!("invalid pin: {v}")))
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            pin_number(v).map(PinLabel::Pin)
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            pin_number(v).map(PinLabel::Pin)
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            whole_pin_number(v).map(PinLabel::Pin)
        }
    }

    deserializer.deserialize_any(AnalogPinVisitor)
}

/// Serialize an analog reader's pin the way the editor writes it: `"A0"` for
/// an analog channel label, a number for a pin.
///
/// # Errors
///
/// Only when the serializer fails.
pub fn serialize_analog_pin<S: serde::Serializer>(pin: &PinLabel, serializer: S) -> Result<S::Ok, S::Error> {
    match pin {
        PinLabel::Analog(channel) => serializer.serialize_str(&format!("A{channel}")),
        PinLabel::Pin(pin) => serializer.serialize_u8(*pin),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[derive(Debug, Deserialize, PartialEq)]
    struct Settings {
        #[serde(default, deserialize_with = "deserialize_whole")]
        count: u8,
        #[serde(default, deserialize_with = "deserialize_whole")]
        delay: u64,
        #[serde(default, deserialize_with = "deserialize_pin_u8")]
        pin: u8,
        #[serde(default, deserialize_with = "deserialize_optional_pin_u8")]
        enable: Option<u8>,
        #[serde(default)]
        steps: Vec<(String, Whole<u8>)>,
    }

    fn read(data: Value) -> Result<Settings, String> {
        serde_json::from_value(data).map_err(|e| e.to_string())
    }

    #[test]
    fn a_whole_number_setting_rounds_a_fraction_to_the_nearest_whole_number() {
        for (written, read_as) in [(json!(25), 25), (json!(25.2), 25), (json!(25.5), 26), (json!(0.4), 0), (json!(254.6), 255)] {
            assert_eq!(read(json!({ "count": written })).unwrap().count, read_as, "{written}");
        }
        assert_eq!(read(json!({ "delay": 1000.7 })).unwrap().delay, 1001);
    }

    #[test]
    fn a_whole_number_setting_that_does_not_fit_is_refused_not_wrapped() {
        for written in [json!(-1), json!(-0.6), json!(256), json!(255.5), json!(1e30), json!(-1e30)] {
            let refused = read(json!({ "count": written })).unwrap_err();
            assert!(refused.contains("expected a whole number from 0 to 255, got"), "{written}: {refused}");
        }
        // A fraction that rounds to zero is zero, not a negative.
        assert_eq!(read(json!({ "count": -0.4 })).unwrap().count, 0);
        assert!(read(json!({ "count": "12" })).unwrap_err().contains("expected a whole number from 0 to 255"));
    }

    #[test]
    fn a_whole_number_inside_a_tuple_rounds_too() {
        let settings = read(json!({ "steps": [["C4", 99.6]] })).unwrap();
        assert_eq!(settings.steps, vec![("C4".to_string(), Whole(100))]);
    }

    #[test]
    fn a_pin_is_a_name_not_a_quantity() {
        for written in [json!(13), json!(13.0), json!("13")] {
            assert_eq!(read(json!({ "pin": written })).unwrap().pin, 13, "{written}");
        }
        for (written, why) in [
            (json!(13.4), "invalid pin: 13.4"),
            (json!("A0"), "invalid pin: A0"),
            (json!(256), "pin out of range: 256"),
            (json!(-1), "pin out of range: -1"),
            (json!(1e30), "pin out of range"),
        ] {
            let refused = read(json!({ "pin": written })).unwrap_err();
            assert!(refused.contains(why), "{written}: {refused}");
        }
    }

    #[test]
    fn an_optional_pin_is_a_pin_or_nothing() {
        assert_eq!(read(json!({})).unwrap().enable, None);
        assert_eq!(read(json!({ "enable": null })).unwrap().enable, None);
        assert_eq!(read(json!({ "enable": "8" })).unwrap().enable, Some(8));
        assert!(read(json!({ "enable": 8.5 })).is_err());
    }

    #[derive(Debug, Deserialize, Serialize, PartialEq)]
    struct Reader {
        #[serde(deserialize_with = "deserialize_analog_pin", serialize_with = "serialize_analog_pin")]
        pin: PinLabel,
    }

    #[test]
    fn an_analog_pin_is_a_label_or_a_pin_number_and_serializes_as_written() {
        for (written, label, back) in [
            (json!("A0"), PinLabel::Analog(0), json!("A0")),
            (json!("a3"), PinLabel::Analog(3), json!("A3")),
            (json!(15), PinLabel::Pin(15), json!(15)),
            (json!("15"), PinLabel::Pin(15), json!(15)),
            (json!(15.0), PinLabel::Pin(15), json!(15)),
        ] {
            let reader: Reader = serde_json::from_value(json!({ "pin": written })).unwrap();
            assert_eq!(reader.pin, label, "{written}");
            assert_eq!(serde_json::to_value(&reader).unwrap(), json!({ "pin": back }));
        }
    }

    #[test]
    fn an_analog_pin_that_names_no_pin_is_refused() {
        for (written, why) in [
            (json!("banana"), "invalid pin: banana"),
            (json!(""), "invalid pin: "),
            (json!("A"), "invalid pin: A"),
            (json!("A999"), "invalid pin: A999"),
            (json!(15.5), "invalid pin: 15.5"),
            (json!(300), "pin out of range: 300"),
            (json!(true), "expected an analog pin"),
        ] {
            let refused = serde_json::from_value::<Reader>(json!({ "pin": written })).unwrap_err().to_string();
            assert!(refused.contains(why), "{written}: {refused}");
        }
    }
}
