//! What a networked Node puts on the wire, written by the board exactly as
//! the live runtime writes it.
//!
//! The live Mqtt node sends a number as Rust's `f64` Display (`1`, `0.1`,
//! `NaN`, `inf`, never `1.00` or `1e21`), a boolean as `true`/`false` and a
//! text as itself; a design variable (Figma, Penpot) coerces what reaches its
//! `set` port to the variable's type and encodes it as
//! [`crate::design_bridge::encode`] does. The sketch does the same with the
//! C++ blocks below, which a Node adds to its shared declarations (the
//! assembler writes each block once):
//!
//! - [`NUMBER_TEXT`]: `mf_number_text(double)`, the Display of a number, and
//!   `mf_payload_number(String)`, a received payload read as the live Mqtt
//!   node reads it (`str::parse::<f64>`, then `true` / `false`).
//! - [`BRIDGE`] (after [`NUMBER_TEXT`]): `mf_bridge_number` / `_bool` /
//!   `_text`, which coerce a value to a variable kind and write its payload,
//!   or answer `false` where the live node publishes nothing.
//!
//! On the ESP32 a `double` is 64 bits, as live, so the text is the same byte
//! for byte. `tests/cloud_sketch.rs` holds both blocks to the live runtime.

use crate::codegen::wire::{CppExpr, CppType};
use crate::design_bridge::VariableKind;

/// `mf_number_text` and `mf_payload_number` (see the module docs). The block
/// includes the C headers it uses (`snprintf`, `strtod`, `memcmp`) itself:
/// `Arduino.h` happens to pull them in on the boards, a plain C++ toolchain
/// does not.
pub const NUMBER_TEXT: &str = r#"#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// x (not negative) as d.ddd...e+x with `precision` digits after the point:
// its digits into `digits`, its decimal exponent returned.
int mf_scientific(double x, int precision, char* digits) {
  char text[64];
  snprintf(text, sizeof text, "%.*e", precision, x);
  const char* p = text;
  int count = 0;
  for (; *p != 'e'; p++) {
    if (*p != '.') {
      digits[count++] = *p;
    }
  }
  return atoi(p + 1);
}
double mf_decimal(const char* digits, int count, int exponent) {
  char text[40];
  snprintf(text, sizeof text, "%c.%.*se%d", digits[0], count - 1, digits + 1, exponent);
  return strtod(text, 0);
}
// One unit up in the last of `count` digits; the new exponent.
int mf_step_up(char* digits, int count, int exponent) {
  int i = count - 1;
  while (i >= 0 && digits[i] == '9') {
    digits[i--] = '0';
  }
  if (i >= 0) {
    digits[i]++;
    return exponent;
  }
  digits[0] = '1';
  return exponent + 1;
}
// The live runtime's text of a number (Rust's f64 Display): the fewest
// digits that read back as the same double, laid out without an exponent.
String mf_number_text(double x) {
  if (x != x) {
    return String("NaN");
  }
  if (x - x != x - x) {
    return String(x < 0 ? "-inf" : "inf");
  }
  // The longest text: "-0." and 323 zeros before the 5 of 5e-324.
  char text[330];
  int length = 0;
  if (x < 0 || (x == 0 && 1.0 / x < 0)) {
    text[length++] = '-';
    x = -x;
  }
  char digits[48];
  int count = 0;
  int exponent = 0;
  // 17 digits always read back: the last pass is the last resort.
  for (int precision = 0; precision <= 16; precision++) {
    count = precision + 1;
    exponent = mf_scientific(x, precision, digits);
    double read = mf_decimal(digits, count, exponent);
    if (read == x) {
      // printf rounds a tie to the even digit; Display writes the upper of
      // two decimals as near. A tie is x itself ending in that 5.
      char longer[48];
      int longer_exponent = mf_scientific(x, precision + 25, longer);
      bool tie = longer_exponent == exponent && memcmp(longer, digits, count) == 0 && longer[count] == '5';
      for (int i = count + 1; tie && i < count + 25; i++) {
        tie = longer[i] == '0';
      }
      if (tie) {
        char up[24];
        memcpy(up, digits, count);
        int up_exponent = mf_step_up(up, count, exponent);
        if (mf_decimal(up, count, up_exponent) == x) {
          memcpy(digits, up, count);
          exponent = up_exponent;
        }
      }
      break;
    }
    // Next to a power of two the doubles below lie closer together than
    // those above, so the decimal one step up can read back where the
    // nearest one does not.
    if (read < x) {
      char up[24];
      memcpy(up, digits, count);
      int up_exponent = mf_step_up(up, count, exponent);
      if (mf_decimal(up, count, up_exponent) == x) {
        memcpy(digits, up, count);
        exponent = up_exponent;
        break;
      }
    }
  }
  while (count > 1 && digits[count - 1] == '0') {
    count--;
  }
  int point = exponent + 1;
  if (point <= 0) {
    text[length++] = '0';
    text[length++] = '.';
    for (int i = point; i < 0; i++) {
      text[length++] = '0';
    }
    for (int i = 0; i < count; i++) {
      text[length++] = digits[i];
    }
  } else {
    for (int i = 0; i < count || i < point; i++) {
      if (i == point) {
        text[length++] = '.';
      }
      text[length++] = i < count ? digits[i] : '0';
    }
  }
  text[length] = '\0';
  return String(text);
}
bool mf_is_digit(char c) {
  return c >= '0' && c <= '9';
}
// `word` in any case.
bool mf_is_word(const char* text, const char* word) {
  for (; *word != '\0'; text++, word++) {
    char c = (*text >= 'A' && *text <= 'Z') ? (char)(*text + 32) : *text;
    if (c != *word) {
      return false;
    }
  }
  return *text == '\0';
}
// Rust's str::parse::<f64> over the whole text: a decimal, inf, infinity or
// nan, with an optional sign.
bool mf_parse_number(const char* text, double& out) {
  const char* p = text;
  if (*p == '+' || *p == '-') {
    p++;
  }
  if (!mf_is_word(p, "inf") && !mf_is_word(p, "infinity") && !mf_is_word(p, "nan")) {
    bool digits = false;
    for (; mf_is_digit(*p); p++) {
      digits = true;
    }
    if (*p == '.') {
      for (p++; mf_is_digit(*p); p++) {
        digits = true;
      }
    }
    if (!digits) {
      return false;
    }
    if (*p == 'e' || *p == 'E') {
      p++;
      if (*p == '+' || *p == '-') {
        p++;
      }
      if (!mf_is_digit(*p)) {
        return false;
      }
      while (mf_is_digit(*p)) {
        p++;
      }
    }
    if (*p != '\0') {
      return false;
    }
  }
  out = strtod(text, 0);
  return true;
}
// A received Mqtt payload as a number, as the live node reads it: a number,
// or true (1) or false (0). Any other text carries no number (0).
double mf_payload_number(const String& payload) {
  double number = 0.0;
  if (mf_parse_number(payload.c_str(), number)) {
    return number;
  }
  if (strcmp(payload.c_str(), "true") == 0) {
    return 1.0;
  }
  return 0.0;
}"#;

/// The design-variable coercion and encoding (see the module docs). Kinds:
/// 0 boolean, 1 float, 2 colour, 3 text — [`kind_code`].
pub const BRIDGE: &str = r#"// A design variable's value on the wire, as the live node's
// design_bridge::coerce + encode write it. Kinds: 0 BOOLEAN, 1 FLOAT,
// 2 COLOR, 3 any other (text). Each answers false where nothing is sent.
bool mf_is_space(char c) {
  return c == ' ' || (c >= '\t' && c <= '\r');
}
String mf_trimmed(const String& text) {
  const char* s = text.c_str();
  unsigned int start = 0;
  unsigned int end = text.length();
  while (start < end && mf_is_space(s[start])) {
    start++;
  }
  while (end > start && mf_is_space(s[end - 1])) {
    end--;
  }
  String out;
  for (unsigned int i = start; i < end; i++) {
    out += s[i];
  }
  return out;
}
String mf_lowered(const String& text) {
  const char* s = text.c_str();
  String out;
  for (unsigned int i = 0; i < text.length(); i++) {
    out += (s[i] >= 'A' && s[i] <= 'Z') ? (char)(s[i] + 32) : s[i];
  }
  return out;
}
// 1 for a true word, 0 for a false word, -1 for neither.
int mf_bool_word(const String& word) {
  static const char* const yes[] = {"true", "yes", "on", "1", "si"};
  static const char* const no[] = {"false", "no", "off", "0", ""};
  for (int i = 0; i < 5; i++) {
    if (strcmp(word.c_str(), yes[i]) == 0) {
      return 1;
    }
    if (strcmp(word.c_str(), no[i]) == 0) {
      return 0;
    }
  }
  return -1;
}
// The finite number the text starts with (12px is 12), as parseFloat.
bool mf_leading_number(const char* text, double& out) {
  const char* p = text;
  if (*p == '+' || *p == '-') {
    p++;
  }
  bool digits = false;
  for (; mf_is_digit(*p); p++) {
    digits = true;
  }
  if (*p == '.') {
    for (p++; mf_is_digit(*p); p++) {
      digits = true;
    }
  }
  if (!digits) {
    return false;
  }
  if (*p == 'e' || *p == 'E') {
    const char* q = p + 1;
    if (*q == '+' || *q == '-') {
      q++;
    }
    if (mf_is_digit(*q)) {
      while (mf_is_digit(*q)) {
        q++;
      }
      p = q;
    }
  }
  String number;
  for (const char* c = text; c < p; c++) {
    number += *c;
  }
  out = strtod(number.c_str(), 0);
  return out - out == 0.0;
}
bool mf_float_from_text(const String& raw, double& out) {
  String trimmed = mf_trimmed(raw);
  String text;
  bool swapped = false;
  for (unsigned int i = 0; i < trimmed.length(); i++) {
    char c = trimmed.c_str()[i];
    if (c == ',' && !swapped) {
      c = '.';
      swapped = true;
    }
    text += c;
  }
  if (text.length() == 0) {
    return false;
  }
  if (mf_leading_number(text.c_str(), out)) {
    return true;
  }
  int word = mf_bool_word(mf_lowered(text));
  if (word < 0) {
    return false;
  }
  out = word;
  return true;
}
bool mf_bool_from_text(const String& raw, bool& out) {
  String word = mf_lowered(mf_trimmed(raw));
  int known = mf_bool_word(word);
  if (known >= 0) {
    out = known == 1;
    return true;
  }
  double number = 0.0;
  if (!mf_float_from_text(word, number)) {
    return false;
  }
  out = number != 0.0;
  return true;
}
double mf_unit(double v) {
  return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v);
}
int mf_hex(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return c - 'a' + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return c - 'A' + 10;
  }
  return -1;
}
// #rgb, #rgba, #rrggbb or #rrggbbaa (the # optional), channels 0-1.
bool mf_color_from_hex(const String& text, double* rgba) {
  const char* s = text.c_str();
  unsigned int length = text.length();
  if (length > 0 && s[0] == '#') {
    s++;
    length--;
  }
  if (length == 0) {
    return false;
  }
  for (unsigned int i = 0; i < length; i++) {
    if (mf_hex(s[i]) < 0) {
      return false;
    }
  }
  char full[8];
  unsigned int n = 0;
  if (length <= 4) {
    for (unsigned int i = 0; i < length; i++) {
      full[n++] = s[i];
      full[n++] = s[i];
    }
  } else if (length == 6 || length == 8) {
    for (unsigned int i = 0; i < length; i++) {
      full[n++] = s[i];
    }
  }
  if (n != 6 && n != 8) {
    return false;
  }
  for (unsigned int k = 0; k < 4; k++) {
    rgba[k] = 2 * k < n ? (mf_hex(full[2 * k]) * 16 + mf_hex(full[2 * k + 1])) / 255.0 : 1.0;
  }
  return true;
}
// rgb(...) / rgba(...) in 0-255 (alpha 0-1), or a hex colour.
bool mf_color_from_text(const String& raw, double* rgba) {
  String text = mf_trimmed(raw);
  String lower = mf_lowered(text);
  const char* s = lower.c_str();
  unsigned int length = lower.length();
  unsigned int start = strncmp(s, "rgba(", 5) == 0 ? 5 : (strncmp(s, "rgb(", 4) == 0 ? 4 : 0);
  if (start == 0 || s[length - 1] != ')') {
    return mf_color_from_hex(text, rgba);
  }
  double parts[4];
  int count = 0;
  String part;
  for (unsigned int i = start; i < length; i++) {
    char c = i + 1 < length ? s[i] : ' ';
    if (mf_is_space(c) || c == ',' || c == '/') {
      if (part.length() > 0) {
        double number = 0.0;
        if (!mf_float_from_text(part, number)) {
          return false;
        }
        if (count < 4) {
          parts[count] = number;
        }
        count++;
        part = String();
      }
    } else {
      part += c;
    }
  }
  if (count != 3 && count != 4) {
    return false;
  }
  for (int k = 0; k < 3; k++) {
    rgba[k] = mf_unit(parts[k] / 255.0);
  }
  rgba[3] = count == 4 ? mf_unit(parts[3]) : 1.0;
  return true;
}
// A colour channel snapped to 8 bits, as JSON writes the double.
String mf_channel_text(double n) {
  double snapped = round(round(mf_unit(n) * 255.0) / 255.0 * 10000.0) / 10000.0;
  String text = mf_number_text(snapped);
  if (strchr(text.c_str(), '.') == 0) {
    text += ".0";
  }
  return text;
}
String mf_color_json(const double* rgba) {
  String out("{\"a\":");
  out += mf_channel_text(rgba[3]);
  out += ",\"b\":";
  out += mf_channel_text(rgba[2]);
  out += ",\"g\":";
  out += mf_channel_text(rgba[1]);
  out += ",\"r\":";
  out += mf_channel_text(rgba[0]);
  out += "}";
  return out;
}
// A JSON string literal of the text.
String mf_json_text(const String& text) {
  String out("\"");
  const char* s = text.c_str();
  for (unsigned int i = 0; i < text.length(); i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"') {
      out += "\\\"";
    } else if (c == '\\') {
      out += "\\\\";
    } else if (c == '\n') {
      out += "\\n";
    } else if (c == '\r') {
      out += "\\r";
    } else if (c == '\t') {
      out += "\\t";
    } else if (c == 0x08) {
      out += "\\b";
    } else if (c == 0x0C) {
      out += "\\f";
    } else if (c < 0x20) {
      char code[8];
      snprintf(code, sizeof code, "\\u%04x", (unsigned int)c);
      out += code;
    } else {
      out += (char)c;
    }
  }
  out += '"';
  return out;
}
bool mf_bridge_number(int kind, double v, String& out) {
  if (v - v != 0.0 || kind == 2) {
    return false;
  }
  if (kind == 0) {
    out = String(v != 0.0 ? "true" : "false");
  } else if (kind == 1) {
    out = mf_number_text(v);
  } else {
    out = mf_json_text(mf_number_text(v));
  }
  return true;
}
bool mf_bridge_bool(int kind, bool v, String& out) {
  if (kind == 2) {
    return false;
  }
  if (kind == 0) {
    out = String(v ? "true" : "false");
  } else if (kind == 1) {
    out = String(v ? "1" : "0");
  } else {
    out = String(v ? "\"true\"" : "\"false\"");
  }
  return true;
}
bool mf_bridge_text(int kind, const String& v, String& out) {
  if (kind == 0) {
    bool state = false;
    if (!mf_bool_from_text(v, state)) {
      return false;
    }
    out = String(state ? "true" : "false");
  } else if (kind == 1) {
    double number = 0.0;
    if (!mf_float_from_text(v, number)) {
      return false;
    }
    out = mf_number_text(number);
  } else if (kind == 2) {
    double rgba[4];
    if (!mf_color_from_text(v, rgba)) {
      return false;
    }
    out = mf_color_json(rgba);
  } else {
    out = mf_json_text(v);
  }
  return true;
}"#;

/// The C++ code of a [`VariableKind`] in [`BRIDGE`].
#[must_use]
pub(crate) fn kind_code(kind: VariableKind) -> u8 {
    match kind {
        VariableKind::Boolean => 0,
        VariableKind::Float => 1,
        VariableKind::Color => 2,
        VariableKind::Text => 3,
    }
}

/// The Mqtt payload of `value`, an Arduino `String` expression: the text the
/// live node's `encode_payload` writes for the value the expression carries.
/// A colour or a list sends nothing (an empty payload); their version 0 is
/// the number 0. Needs [`NUMBER_TEXT`].
#[must_use]
pub fn mqtt_payload(value: &CppExpr) -> String {
    let c = &value.code;
    match value.ty {
        CppType::Str => format!("({c})"),
        CppType::Bool => format!("(({c}) ? String(\"true\") : String(\"false\"))"),
        CppType::Double => format!("mf_number_text((double)({c}))"),
        CppType::Opaque => format!("((({c}) != 0) ? String(\"\") : String(\"0\"))"),
    }
}

/// A C++ `bool` expression that coerces `value` to a variable of `kind`,
/// writes its payload into the `String` named `out` and is `true`, or is
/// `false` where the live node publishes nothing. `None` where the board
/// cannot know what the live node sends: a colour (whose channels the board
/// does not carry) into a colour variable. Needs [`NUMBER_TEXT`] and
/// [`BRIDGE`].
#[must_use]
pub(crate) fn bridge_payload(kind: VariableKind, value: &CppExpr, out: &str) -> Option<String> {
    let code = kind_code(kind);
    let c = &value.code;
    Some(match value.ty {
        CppType::Bool => format!("mf_bridge_bool({code}, ({c}), {out})"),
        CppType::Double => format!("mf_bridge_number({code}, (double)({c}), {out})"),
        CppType::Str => format!("mf_bridge_text({code}, ({c}), {out})"),
        // A version past 0 is a colour or a list: neither fits a boolean, a
        // number or a text. Version 0 is the number 0.
        CppType::Opaque if kind == VariableKind::Color => return None,
        CppType::Opaque => format!("((({c}) == 0) && mf_bridge_number({code}, 0.0, {out}))"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_payload_follows_the_type_of_what_is_sent() {
        assert_eq!(mqtt_payload(&CppExpr::number("x")), "mf_number_text((double)(x))");
        assert_eq!(mqtt_payload(&CppExpr::boolean("b")), "((b) ? String(\"true\") : String(\"false\"))");
        assert_eq!(mqtt_payload(&CppExpr::text("s")), "(s)");
        assert_eq!(mqtt_payload(&CppExpr::opaque("v")), "(((v) != 0) ? String(\"\") : String(\"0\"))");
    }

    #[test]
    fn a_colour_into_a_colour_variable_is_the_one_the_board_cannot_send() {
        assert_eq!(bridge_payload(VariableKind::Color, &CppExpr::opaque("v"), "p"), None);
        assert_eq!(
            bridge_payload(VariableKind::Float, &CppExpr::opaque("v"), "p").as_deref(),
            Some("(((v) == 0) && mf_bridge_number(1, 0.0, p))")
        );
        assert_eq!(
            bridge_payload(VariableKind::Text, &CppExpr::text("s"), "p").as_deref(),
            Some("mf_bridge_text(3, (s), p)")
        );
    }
}
