//! The design-tool bridge wire protocol — the Rust mirror of
//! `packages/design-bridge/src/{protocol,codec}.ts`, which the Figma and Penpot
//! plugins use. Both sides are checked against
//! `packages/design-bridge/fixtures/protocol.json`.
//!
//! Every topic is `microflow/{uid}/{client}/…`, where `{client}` is the sender:
//! a design tool (`figma`, `penpot`) or Studio (`app`).

use serde_json::Value;

/// The design tools a node can bridge to; each is a topic segment.
pub(crate) const DESIGN_TOOLS: [&str; 2] = ["figma", "penpot"];

/// Studio's client segment.
pub(crate) const STUDIO: &str = "app";

const ROOT: &str = "microflow";

/// The topic-safe form of a variable ID. Figma: `VariableID:1:2` → `1-2`.
/// Penpot token IDs (uuids) are already safe and pass through unchanged.
pub(crate) fn wire_id(id: &str) -> String {
    id.strip_prefix("VariableID:").unwrap_or(id).replace(':', "-")
}

/// `connected` / `disconnected`, retained.
pub(crate) fn status_topic(uid: &str, client: &str) -> String {
    format!("{ROOT}/{uid}/{client}/status")
}

/// The tool's retained variable list.
pub(crate) fn variables_topic(uid: &str, tool: &str) -> String {
    format!("{ROOT}/{uid}/{tool}/variables")
}

/// A variable's current value, published by `client`.
pub(crate) fn value_topic(uid: &str, client: &str, wire_id: &str) -> String {
    format!("{ROOT}/{uid}/{client}/variable/{wire_id}")
}

/// Studio asks the owning tool to change a variable.
pub(crate) fn set_topic(uid: &str, wire_id: &str) -> String {
    format!("{ROOT}/{uid}/{STUDIO}/variable/{wire_id}/set")
}

/// Studio asks every tool to send its list and current values.
pub(crate) fn request_topic(uid: &str) -> String {
    format!("{ROOT}/{uid}/{STUDIO}/variables/request")
}

/// The bridge uid a topic belongs to, or `None` for topics outside the protocol.
/// Studio announces itself only for these uids, never for an arbitrary
/// `microflow/…` topic.
pub(crate) fn bridge_uid(topic: &str) -> Option<&str> {
    let parts: Vec<&str> = topic.split('/').collect();
    let (&root, &uid, &client, rest) = match parts.as_slice() {
        [root, uid, client, rest @ ..] => (root, uid, client, rest),
        _ => return None,
    };
    if root != ROOT || uid.is_empty() || client.is_empty() {
        return None;
    }
    let known = matches!(
        rest,
        ["status" | "variables"]
            | ["variables", "request" | "response"]
            | ["variable", _]
            | ["variable", _, "set"]
    );
    let wire_id_ok = match rest {
        ["variable", id] | ["variable", id, "set"] => !id.is_empty(),
        _ => true,
    };
    (known && wire_id_ok).then_some(uid)
}

/// A variable value on the wire. Colors use the 0–1 range per channel.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum BridgeValue {
    Bool(bool),
    Number(f64),
    Text(String),
    Color { r: f64, g: f64, b: f64, a: f64 },
}

/// Decode a raw payload: JSON when it parses, the text itself otherwise.
pub(crate) fn decode_payload(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

/// Coerce a decoded value to a variable's type (`BOOLEAN`, `FLOAT`, `COLOR`;
/// anything else is text). `None` when the value does not fit.
pub(crate) fn coerce(resolved_type: &str, value: &Value) -> Option<BridgeValue> {
    match resolved_type {
        "BOOLEAN" => to_bool(value).map(BridgeValue::Bool),
        "FLOAT" => to_float(value).map(BridgeValue::Number),
        "COLOR" => to_color(value),
        _ => to_text(value).map(BridgeValue::Text),
    }
}

/// Encode a value for the wire. Color channels are snapped to 8 bits (what
/// Penpot's hex and Studio's channels hold), so a color survives a round trip
/// through any tool unchanged and is not published back as an echo.
pub(crate) fn encode(value: &BridgeValue) -> String {
    match value {
        BridgeValue::Bool(b) => b.to_string(),
        BridgeValue::Number(n) => n.to_string(),
        BridgeValue::Text(s) => Value::String(s.clone()).to_string(),
        BridgeValue::Color { r, g, b, a } => serde_json::json!({
            "r": channel(*r),
            "g": channel(*g),
            "b": channel(*b),
            "a": channel(*a),
        })
        .to_string(),
    }
}

const TRUE_WORDS: [&str; 5] = ["true", "yes", "on", "1", "si"];
const FALSE_WORDS: [&str; 5] = ["false", "no", "off", "0", ""];

fn to_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()).map(|n| n != 0.0),
        Value::String(s) => {
            let word = s.trim().to_lowercase();
            if TRUE_WORDS.contains(&word.as_str()) {
                Some(true)
            } else if FALSE_WORDS.contains(&word.as_str()) {
                Some(false)
            } else {
                float_from_text(&word).map(|n| n != 0.0)
            }
        }
        _ => None,
    }
}

fn to_float(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => float_from_text(s),
        _ => None,
    }
}

fn float_from_text(text: &str) -> Option<f64> {
    let text = text.trim().replacen(',', ".", 1);
    if text.is_empty() {
        return None;
    }
    if let Some(n) = text.parse::<f64>().ok().filter(|n| n.is_finite()) {
        return Some(n);
    }
    // Allow a unit suffix such as `12px` or `90deg`.
    if let Some(n) = leading_float(&text) {
        return Some(n);
    }
    let word = text.to_lowercase();
    if TRUE_WORDS.contains(&word.as_str()) {
        Some(1.0)
    } else if FALSE_WORDS.contains(&word.as_str()) {
        Some(0.0)
    } else {
        None
    }
}

/// The number at the start of `text`, like JavaScript's `parseFloat`.
fn leading_float(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end += 1;
    }
    let digits_start = end;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'.' {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
    }
    if !text[digits_start..end].bytes().any(|b| b.is_ascii_digit()) {
        return None;
    }
    if end < bytes.len() && matches!(bytes[end], b'e' | b'E') {
        let mut exp = end + 1;
        if matches!(bytes.get(exp), Some(b'+' | b'-')) {
            exp += 1;
        }
        let exp_digits = exp;
        while exp < bytes.len() && bytes[exp].is_ascii_digit() {
            exp += 1;
        }
        if exp > exp_digits {
            end = exp;
        }
    }
    text[..end].parse::<f64>().ok().filter(|n| n.is_finite())
}

fn to_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => n.as_f64().map(|n| n.to_string()),
        _ => None,
    }
}

/// Accepts `{r, g, b, a?}` with channels 0–1, a hex string (`#rgb`, `#rgba`,
/// `#rrggbb`, `#rrggbbaa`, `#` optional) or CSS `rgb()` / `rgba()`.
fn to_color(value: &Value) -> Option<BridgeValue> {
    match value {
        Value::String(s) => color_from_text(s),
        Value::Object(obj) => {
            let channel = |key: &str, default: Option<f64>| match obj.get(key) {
                Some(v) => to_float(v),
                None => default,
            };
            Some(BridgeValue::Color {
                r: channel("r", None)?.clamp(0.0, 1.0),
                g: channel("g", None)?.clamp(0.0, 1.0),
                b: channel("b", None)?.clamp(0.0, 1.0),
                a: channel("a", Some(1.0))?.clamp(0.0, 1.0),
            })
        }
        _ => None,
    }
}

fn color_from_text(text: &str) -> Option<BridgeValue> {
    let text = text.trim();
    let lower = text.to_lowercase();
    let inner = lower
        .strip_prefix("rgba(")
        .or_else(|| lower.strip_prefix("rgb("))
        .and_then(|rest| rest.strip_suffix(')'));
    let Some(inner) = inner else {
        return color_from_hex(text);
    };
    let parts: Vec<f64> = inner
        .split(|c: char| c.is_whitespace() || c == ',' || c == '/')
        .filter(|p| !p.is_empty())
        .map(float_from_text)
        .collect::<Option<_>>()?;
    let (r, g, b, a) = match parts.as_slice() {
        [r, g, b] => (*r, *g, *b, 1.0),
        [r, g, b, a] => (*r, *g, *b, *a),
        _ => return None,
    };
    Some(BridgeValue::Color {
        r: (r / 255.0).clamp(0.0, 1.0),
        g: (g / 255.0).clamp(0.0, 1.0),
        b: (b / 255.0).clamp(0.0, 1.0),
        a: a.clamp(0.0, 1.0),
    })
}

fn color_from_hex(text: &str) -> Option<BridgeValue> {
    let hex = text.strip_prefix('#').unwrap_or(text);
    if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let full: String = if hex.len() <= 4 {
        hex.chars().flat_map(|c| [c, c]).collect()
    } else {
        hex.to_string()
    };
    if full.len() != 6 && full.len() != 8 {
        return None;
    }
    let byte = |i: usize| {
        u8::from_str_radix(&full[i..i + 2], 16)
            .ok()
            .map(|v| f64::from(v) / 255.0)
    };
    Some(BridgeValue::Color {
        r: byte(0)?,
        g: byte(2)?,
        b: byte(4)?,
        a: if full.len() == 8 { byte(6)? } else { 1.0 },
    })
}

fn channel(n: f64) -> f64 {
    let byte = (n.clamp(0.0, 1.0) * 255.0).round() / 255.0;
    (byte * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/design-bridge/fixtures/protocol.json"
    ));

    fn fixture(section: &str) -> Vec<Value> {
        let all: Value = serde_json::from_str(FIXTURE).expect("fixture is JSON");
        all[section].as_array().expect("fixture section").clone()
    }

    fn str_of<'a>(case: &'a Value, key: &str) -> &'a str {
        case[key].as_str().unwrap_or_else(|| panic!("{key} in {case}"))
    }

    fn assert_matches(actual: Option<&BridgeValue>, expected: &Value, case: &Value) {
        match (actual, expected) {
            (None, Value::Null) => {}
            (Some(BridgeValue::Bool(a)), Value::Bool(e)) => assert_eq!(a, e, "{case}"),
            (Some(BridgeValue::Number(a)), Value::Number(e)) => {
                assert!((a - e.as_f64().unwrap()).abs() < 1e-9, "{case}: {a}");
            }
            (Some(BridgeValue::Text(a)), Value::String(e)) => assert_eq!(a, e, "{case}"),
            (Some(BridgeValue::Color { r, g, b, a }), Value::Object(e)) => {
                for (got, key) in [(r, "r"), (g, "g"), (b, "b"), (a, "a")] {
                    let want = e[key].as_f64().unwrap();
                    assert!((got - want).abs() < 1e-3, "{case}: {key} = {got}");
                }
            }
            (actual, _) => panic!("{case}: got {actual:?}"),
        }
    }

    fn value_from_json(value: &Value) -> BridgeValue {
        match value {
            Value::Bool(b) => BridgeValue::Bool(*b),
            Value::Number(n) => BridgeValue::Number(n.as_f64().unwrap()),
            Value::String(s) => BridgeValue::Text(s.clone()),
            Value::Object(o) => BridgeValue::Color {
                r: o["r"].as_f64().unwrap(),
                g: o["g"].as_f64().unwrap(),
                b: o["b"].as_f64().unwrap(),
                a: o["a"].as_f64().unwrap(),
            },
            other => panic!("unsupported fixture value {other}"),
        }
    }

    /// JSON equality that treats `1` and `1.0` as the same number.
    fn json_eq(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
            }
            _ => a == b,
        }
    }

    #[test]
    fn wire_ids_match_fixture() {
        for case in fixture("wireIds") {
            assert_eq!(wire_id(str_of(&case, "id")), str_of(&case, "wireId"), "{case}");
        }
    }

    #[test]
    fn topics_match_fixture() {
        for case in fixture("topics") {
            let args: Vec<&str> = case["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap())
                .collect();
            let topic = match (str_of(&case, "fn"), args.as_slice()) {
                ("status", [uid, client]) => status_topic(uid, client),
                ("variables", [uid, tool]) => variables_topic(uid, tool),
                ("value", [uid, client, id]) => value_topic(uid, client, id),
                ("set", [uid, id]) => set_topic(uid, id),
                ("request", [uid]) => request_topic(uid),
                ("response", [uid, to]) => format!("microflow/{uid}/{to}/variables/response"),
                (other, _) => panic!("unknown topic fn {other}"),
            };
            assert_eq!(topic, str_of(&case, "topic"), "{case}");
            assert!(bridge_uid(&topic).is_some(), "{topic} is a bridge topic");
        }
    }

    #[test]
    fn bridge_uids_match_fixture() {
        for case in fixture("bridgeUids") {
            assert_eq!(bridge_uid(str_of(&case, "topic")), case["uid"].as_str(), "{case}");
        }
    }

    #[test]
    fn coercion_matches_fixture() {
        for case in fixture("coerce") {
            let decoded = decode_payload(str_of(&case, "payload"));
            let value = coerce(str_of(&case, "type"), &decoded);
            assert_matches(value.as_ref(), &case["value"], &case);
        }
    }

    #[test]
    fn encoding_matches_fixture() {
        for case in fixture("encode") {
            let encoded = encode(&value_from_json(&case["value"]));
            let got: Value = serde_json::from_str(&encoded).expect("encoded JSON");
            let want: Value = serde_json::from_str(str_of(&case, "payload")).unwrap();
            assert!(json_eq(&got, &want), "{case}: got {encoded}");
        }
    }

    #[test]
    fn unknown_type_is_text() {
        assert_eq!(
            coerce("EASING", &Value::from("ease-in")),
            Some(BridgeValue::Text("ease-in".into()))
        );
    }
}
