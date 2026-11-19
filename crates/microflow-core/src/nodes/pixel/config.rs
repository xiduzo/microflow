//! Pixel Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The order a strip takes its colour bytes in. Read here once, so the live
/// runtime and the sketch cannot read a stored order differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum ColorOrder {
    /// The order of a WS2812 / `NeoPixel` strip, which most strips are.
    #[default]
    Grb,
    Rgb,
    Brg,
}

impl ColorOrder {
    /// The order a stored name means. The editor writes `GRB` / `RGB` /
    /// `BRG`; the case is ignored (`rgb` is RGB), and a name that is none of
    /// the three is GRB.
    #[must_use]
    pub(crate) fn from_name(name: &str) -> Self {
        if name.eq_ignore_ascii_case("RGB") {
            Self::Rgb
        } else if name.eq_ignore_ascii_case("BRG") {
            Self::Brg
        } else {
            Self::Grb
        }
    }

    /// The name the editor writes for this order.
    #[must_use]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Grb => "GRB",
            Self::Rgb => "RGB",
            Self::Brg => "BRG",
        }
    }
}

impl<'de> Deserialize<'de> for ColorOrder {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::from_name(&String::deserialize(deserializer)?))
    }
}

impl Serialize for ColorOrder {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PixelConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub(crate) pin: u8,
    #[serde(default = "default_length", deserialize_with = "serde_utils::deserialize_whole")]
    pub(crate) length: u16,
    #[serde(default)]
    pub(crate) color_order: ColorOrder,
    #[serde(default)]
    pub(crate) presets: Vec<Vec<String>>,
}

fn default_pin() -> u8 {
    11
}
fn default_length() -> u16 {
    32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::resolve;
    use serde_json::json;

    /// A strip that names no pin or colour order is the strip the editor
    /// places (`pixel.schema.ts`): pin 11, GRB — the order of a WS2812 /
    /// `NeoPixel` strip. Every strip the editor made carries both, so only a
    /// hand-written node relies on this.
    #[test]
    fn a_strip_without_pin_or_color_order_is_the_editors_default() {
        let config: PixelConfig = resolve(&json!({})).unwrap();
        assert_eq!((config.pin, config.color_order, config.length), (11, ColorOrder::Grb, 32));
    }

    /// The default is only for a strip that names no order: one that names
    /// its order keeps it, in any case.
    #[test]
    fn a_strip_that_names_its_color_order_keeps_it() {
        let cases = [
            ("BRG", ColorOrder::Brg),
            ("brg", ColorOrder::Brg),
            ("RGB", ColorOrder::Rgb),
            ("rGb", ColorOrder::Rgb),
            ("GRB", ColorOrder::Grb),
            ("grb", ColorOrder::Grb),
        ];
        for (stored, order) in cases {
            let config: PixelConfig = resolve(&json!({ "color_order": stored })).unwrap();
            assert_eq!(config.color_order, order, "`{stored}`");
            assert_eq!(serde_json::to_value(config.color_order).unwrap(), json!(order.name()));
        }
    }

    /// A name that is none of the three orders is GRB, live and in the sketch
    /// alike.
    #[test]
    fn an_order_that_is_none_of_the_three_is_grb() {
        for stored in ["RBG", "", "bgr"] {
            let config: PixelConfig = resolve(&json!({ "color_order": stored })).unwrap();
            assert_eq!(config.color_order, ColorOrder::Grb, "`{stored}`");
        }
    }
}
