//! Serde visitors used by component configs to accept either a string or a
//! number for pin fields. Ported verbatim from the desktop runtime.

use serde::de::{self, Visitor};

/// Deserialize a pin value from either a string or number to `String`.
/// Handles: "A0", "14", 14, 14.0 -> "A0", "14", "14", "14".
pub fn deserialize_string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct StringOrNumberVisitor;

    impl Visitor<'_> for StringOrNumberVisitor {
        type Value = String;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string or number")
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            Ok(v.to_string())
        }

        fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
            Ok(v)
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(v.to_string())
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(v.to_string())
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            Ok((v as i64).to_string())
        }
    }

    deserializer.deserialize_any(StringOrNumberVisitor)
}

/// Deserialize a pin value from string or number to `u8`.
/// Handles: "14", 14, 14.0 -> 14u8.
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

        fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
            v.parse().map_err(|_| de::Error::custom(format!("invalid pin: {v}")))
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            u8::try_from(v).map_err(|_| de::Error::custom(format!("pin out of range: {v}")))
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            u8::try_from(v).map_err(|_| de::Error::custom(format!("pin out of range: {v}")))
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            let i = v as i64;
            u8::try_from(i).map_err(|_| de::Error::custom(format!("pin out of range: {v}")))
        }
    }

    deserializer.deserialize_any(PinU8Visitor)
}
