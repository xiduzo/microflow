//! Node config resolution: the one step that turns a Node's `data` into its
//! config, for both halves of the engine.
//!
//! Each Node's config lives with the Node, in `crate::nodes::<node>::config`
//! (ADR-0026), and is read in exactly one way: [`resolve`]. The live runtime
//! (interpret) calls it when the `ComponentRegistry` builds a Node; every
//! Arduino emitter (emit) calls it before it writes a line of C++. A `data`
//! that cannot be read is therefore the same fact on both sides — an
//! [`UnreadableConfig`] — and neither side substitutes defaults for it:
//!
//! - **interpret** reports it as Node health: the Node is not running
//!   (`RuntimeError::ConfigDeserialize`);
//! - **emit** reports it as an error-severity `ValidationProblem` naming the
//!   Node, and no Sketch is generated.
//!
//! What a *missing* field means is the config's own business (its serde
//! defaults); `resolve` only refuses a `data` whose present fields do not fit.
//! The Catalog Parity Guard (`apps/web/src-tauri/tests/catalog_parity.rs`)
//! feeds every Component Catalog entry's editor defaults through this step, so
//! a default the engine cannot read, or reads differently, fails CI.
//!
//! [`serde_utils`] holds how the configs read a number: a whole-number setting
//! (a fraction is rounded), a pin, an analog pin.
//! Ungated like the configs, so codegen-only consumers reach all of this
//! without the `runtime` feature.

pub mod serde_utils;

use serde::de::DeserializeOwned;
use serde_json::Value;

/// The quiet window, in ms, a digital input (Button, Switch) settles its
/// contacts with: an edge within this of the previous one waits until the
/// line has held quiet this long. Must exceed one 50Hz mains period (20ms): a
/// floating pin picks up hum as dead-regular ~20ms edges, and a window at
/// exactly that period razor-edges between accepting and rejecting every
/// edge. A clean edge after a quiet line is accepted at once. The live nodes
/// and their emitted sketch (`codegen::emit::debounced_read`) both settle by
/// it.
pub(crate) const DEBOUNCE_MS: u64 = 50;

/// How many characters of a value a reason quotes before it is cut short.
const MAX_QUOTED: usize = 40;
/// How many characters a reason has at most, the setting's path not counted.
const MAX_REASON: usize = 240;
/// The most fields an object can have and still be searched for the setting
/// that is unreadable: more than any config has settings.
const MAX_FIELDS_SEARCHED: usize = 64;

/// A Node's `data` could not be read into its config. Displays as the setting
/// and what is wrong with it — `pin: invalid pin: left`,
/// `pins.red: pin out of range: 300`, ``gate: unknown variant `maybe`, …`` —
/// or the reason alone when no single setting can be named.
///
/// The text is shown in the editor, and the value it quotes is whatever the
/// Flow holds, so it is bounded ([`bounded`]): the setting's path is whole, a
/// quoted value is cut after [`MAX_QUOTED`] characters, and the reason as a
/// whole after [`MAX_REASON`].
#[derive(Debug)]
pub struct UnreadableConfig {
    /// The setting that could not be read, as a path into `data` (`freq`,
    /// `pins.red`, `shapes[0]`); `None` when `data` itself is not an object,
    /// or [`locate`] cannot tell one setting from another.
    setting: Option<String>,
    reason: serde_json::Error,
}

impl std::fmt::Display for UnreadableConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = bounded(&self.reason.to_string());
        match &self.setting {
            Some(setting) => write!(f, "{setting}: {reason}"),
            None => f.write_str(&reason),
        }
    }
}

/// `reason` with every quoted value (`"…"` as serde escapes a string, `` `…` ``
/// around a variant) cut to its first [`MAX_QUOTED`] characters and an
/// ellipsis, and the whole cut to [`MAX_REASON`] characters and an ellipsis
/// (a reason can also carry a value without quotation marks).
fn bounded(reason: &str) -> String {
    let mut out = String::new();
    let mut chars = reason.chars();
    while let Some(opening) = chars.next() {
        out.push(opening);
        if opening != '"' && opening != '`' {
            continue;
        }
        // To the closing mark, or to the end when there is none. Inside
        // `"…"` a backslash escapes the character after it.
        let (mut quoted, mut escaped) = (0, false);
        let mut closing = None;
        for c in chars.by_ref() {
            if c == opening && !escaped {
                closing = Some(c);
                break;
            }
            escaped = opening == '"' && c == '\\' && !escaped;
            if quoted < MAX_QUOTED {
                out.push(c);
            }
            quoted += 1;
        }
        if quoted > MAX_QUOTED {
            out.push('…');
        }
        out.extend(closing);
    }
    if let Some((cut, _)) = out.char_indices().nth(MAX_REASON) {
        out.truncate(cut);
        out.push('…');
    }
    out
}

impl std::error::Error for UnreadableConfig {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.reason)
    }
}

/// Read a Node's `data` into its config `C`.
///
/// # Errors
///
/// [`UnreadableConfig`] when a field of `data` does not fit `C` (a pin that is
/// not a pin, an option `C` does not know), or `data` is not an object.
pub fn resolve<C: DeserializeOwned>(data: &Value) -> Result<C, UnreadableConfig> {
    read::<C>(data).map_err(|reason| unreadable(data, reason, &|changed| read::<C>(changed).map(drop)))
}

/// `data` as `C`. Kept out of line so each config's deserializer is compiled
/// once, however many places read it.
#[inline(never)]
fn read<C: DeserializeOwned>(data: &Value) -> Result<C, serde_json::Error> {
    C::deserialize(data)
}

/// The [`UnreadableConfig`] for a `data` that failed to read with `reason`,
/// naming the setting ([`locate`]). `reread` reads a changed copy of `data`
/// into the same config. Not generic: every config shares this one copy.
fn unreadable(
    data: &Value,
    reason: serde_json::Error,
    reread: &dyn Fn(&Value) -> Result<(), serde_json::Error>,
) -> UnreadableConfig {
    let failure = reason.to_string();
    let probe = |changed: &Value| match reread(changed) {
        Ok(()) => Probe::Reads,
        Err(error) if error.to_string() == failure => Probe::SameFailure,
        Err(_) => Probe::AnotherFailure,
    };
    UnreadableConfig { setting: locate(data, &probe), reason }
}

/// What reading a changed copy of an unreadable `data` gives.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Probe {
    Reads,
    /// Unreadable for the reason the original `data` is.
    SameFailure,
    AnotherFailure,
}

/// One step into `data`: a field of an object, or an element of a list.
enum Step {
    Field(String),
    Element(usize),
}

/// Name the setting that makes `data` unreadable, as a path (`pins.red`,
/// `shapes[0]`). Serde says what is wrong but not where, and tracking the path
/// inside the deserializer would be compiled again for every config (it grew
/// the browser's codegen module by a sixth). This runs on the failure path
/// only, and asks the question directly: which one setting, when it is taken
/// out of `data`, takes the failure with it?
///
/// - In an object, the one field whose removal lets `data` read — or, when
///   none does, the one whose removal changes the failure.
/// - In a list, the element that ends the shortest prefix that still fails.
///   The elements behind it play no part in the rest of the search.
///
/// The search goes deeper while exactly one setting answers, and stops with
/// what it has otherwise: two settings unreadable for the same reason, or a
/// fixed-length entry (a song note), name only the setting around them.
///
/// Every question re-reads the whole of `data`, so their number is kept small
/// whatever `data` holds: one per field of an object, and none for an object
/// with more than [`MAX_FIELDS_SEARCHED`] fields; for a list, as many as it
/// takes to halve it down to one element (13 for 5,000).
fn locate(data: &Value, probe: &dyn Fn(&Value) -> Probe) -> Option<String> {
    let mut changed = data.clone();
    let mut path: Vec<Step> = Vec::new();
    while let Some(step) = culprit(&mut changed, &path, probe) {
        path.push(step);
    }
    if path.is_empty() {
        return None;
    }
    let steps: Vec<String> = path
        .iter()
        .map(|step| match step {
            Step::Field(field) => format!(".{field}"),
            Step::Element(index) => format!("[{index}]"),
        })
        .collect();
    Some(steps.concat().trim_start_matches('.').to_string())
}

/// The value at `path` inside `data`.
fn at<'a>(data: &'a mut Value, path: &[Step]) -> Option<&'a mut Value> {
    path.iter().try_fold(data, |value, step| match step {
        Step::Field(field) => value.get_mut(field),
        Step::Element(index) => value.get_mut(*index),
    })
}

/// The one setting directly under `path` that carries the failure, if exactly
/// one does. `data` is changed while a probe runs and put back after it, but
/// for a list, which is left cut off behind its unreadable element.
fn culprit(data: &mut Value, path: &[Step], probe: &dyn Fn(&Value) -> Probe) -> Option<Step> {
    match at(data, path)? {
        Value::Object(fields) => {
            if fields.len() > MAX_FIELDS_SEARCHED {
                return None;
            }
            let names: Vec<String> = fields.keys().cloned().collect();
            let mut without: Vec<(String, Probe)> = Vec::with_capacity(names.len());
            for name in names {
                let removed = at(data, path)?.as_object_mut()?.remove(&name)?;
                without.push((name.clone(), probe(data)));
                at(data, path)?.as_object_mut()?.insert(name, removed);
            }
            let only = |wanted: &dyn Fn(Probe) -> bool| {
                let mut matching = without.iter().filter(|(_, result)| wanted(*result));
                match (matching.next(), matching.next()) {
                    (Some((name, _)), None) => Some(Step::Field(name.clone())),
                    _ => None,
                }
            };
            only(&|result| result == Probe::Reads).or_else(|| only(&|result| result != Probe::SameFailure))
        }
        Value::Array(elements) => {
            // The list as it is fails. A list reads up to its first
            // unreadable element and fails from there on, so the shortest
            // prefix that fails is found by halving: `reads` elements are
            // known (or, for none, taken) to read, `fails` to fail.
            let (mut reads, mut fails) = (0, elements.len());
            while fails - reads > 1 {
                let keep = reads + (fails - reads) / 2;
                let rest = at(data, path)?.as_array_mut()?.split_off(keep);
                let result = probe(data);
                at(data, path)?.as_array_mut()?.extend(rest);
                match result {
                    Probe::Reads => reads = keep,
                    Probe::SameFailure => fails = keep,
                    // A shorter copy is unreadable in its own right: a
                    // fixed-length entry, where no element can be left out.
                    Probe::AnotherFailure => return None,
                }
            }
            // Nothing behind that element was read, so nothing behind it is
            // kept: what the search asks next is about this element alone,
            // whatever else is unreadable further on.
            at(data, path)?.as_array_mut()?.truncate(fails);
            fails.checked_sub(1).map(Step::Element)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Config {
        #[serde(default = "default_pin")]
        pin: u8,
    }

    fn default_pin() -> u8 {
        13
    }

    #[test]
    fn a_missing_field_takes_the_configs_default() {
        assert_eq!(resolve::<Config>(&json!({})).unwrap(), Config { pin: 13 });
    }

    #[test]
    fn fields_the_config_does_not_know_are_ignored() {
        assert_eq!(resolve::<Config>(&json!({ "pin": 4, "label": "LED" })).unwrap(), Config { pin: 4 });
    }

    #[test]
    fn a_field_that_does_not_fit_is_unreadable_and_says_why() {
        let unreadable = resolve::<Config>(&json!({ "pin": "left" })).unwrap_err();
        assert_eq!(unreadable.to_string(), "pin: invalid type: string \"left\", expected u8");
    }

    #[derive(Debug, Deserialize)]
    #[allow(dead_code)]
    struct Nested {
        #[serde(default)]
        pin: u8,
        #[serde(default)]
        other: u8,
        #[serde(default)]
        pins: Option<Config>,
        #[serde(default)]
        shapes: Vec<Vec<u8>>,
        #[serde(default)]
        song: Vec<(String, u8)>,
        #[serde(default)]
        tracks: Vec<Track>,
    }

    #[derive(Debug, Deserialize)]
    #[allow(dead_code)]
    struct Track {
        name: String,
    }

    fn unreadable(data: serde_json::Value) -> String {
        resolve::<Nested>(&data).unwrap_err().to_string()
    }

    #[test]
    fn the_reason_names_a_nested_setting_by_its_path() {
        let reason = unreadable(json!({ "pin": 4, "pins": { "pin": -1, "label": "x" } }));
        assert!(reason.starts_with("pins.pin: invalid value: integer `-1`"), "{reason}");
    }

    #[test]
    fn the_reason_names_the_element_of_a_list() {
        let reason = unreadable(json!({ "shapes": [[1, 2], [3, "four", 5], [6]] }));
        assert!(reason.starts_with("shapes[1][1]: invalid type: string \"four\""), "{reason}");
        // A required field of a list element: taking it out changes the failure.
        let reason = unreadable(json!({ "tracks": [{ "name": "a" }, { "name": 7 }] }));
        assert!(reason.starts_with("tracks[1].name: invalid type: integer `7`"), "{reason}");
    }

    #[test]
    fn a_fixed_length_entry_is_named_as_a_whole() {
        let reason = unreadable(json!({ "song": [["C4", 1], ["D4", "loud"]] }));
        assert!(reason.starts_with("song[1]: invalid type: string \"loud\""), "{reason}");
    }

    #[test]
    fn the_first_of_two_unreadable_settings_is_named() {
        let reason = unreadable(json!({ "other": "b", "pin": "a" }));
        assert!(reason.starts_with("other: invalid type: string \"b\""), "{reason}");
    }

    #[test]
    fn two_settings_unreadable_for_the_same_reason_leave_the_reason_alone() {
        let reason = unreadable(json!({ "other": "left", "pin": "left" }));
        assert!(reason.starts_with("invalid type: string \"left\""), "{reason}");
    }

    /// The reason a `Nested` cannot be read from `data`, and how many times
    /// `data` was read again to name the setting.
    fn located(data: &serde_json::Value) -> (String, usize) {
        let reason = read::<Nested>(data).unwrap_err();
        let rereads = std::cell::Cell::new(0);
        let unreadable = super::unreadable(data, reason, &|changed| {
            rereads.set(rereads.get() + 1);
            read::<Nested>(changed).map(drop)
        });
        (unreadable.to_string(), rereads.get())
    }

    /// Every re-read costs the whole of `data`, so a list is searched by
    /// halving, not entry by entry: a dozen re-reads for 5,000 entries. The
    /// unreadable entry behind the first one does not blur where in the first
    /// the trouble is.
    #[test]
    fn a_bad_entry_late_in_a_long_list_is_named_in_a_handful_of_rereads() {
        let mut shapes = vec![json!([1, 2, 3]); 5000];
        shapes[4998] = json!([3, "four", 5]);
        shapes[4999] = json!([6, "seven"]);

        let (reason, rereads) = located(&json!({ "pin": 4, "shapes": shapes }));

        assert!(reason.starts_with("shapes[4998][1]: invalid type: string \"four\""), "{reason}");
        assert!(rereads <= 32, "{rereads} re-reads");
    }

    #[test]
    fn the_first_and_the_last_entry_of_a_list_are_named() {
        let mut shapes = vec![json!([1]); 9];
        shapes[0] = json!(["zero"]);
        assert!(unreadable(json!({ "shapes": shapes })).starts_with("shapes[0][0]: "));

        let mut shapes = vec![json!([1]); 9];
        shapes[8] = json!([1, 2, "two"]);
        assert!(unreadable(json!({ "shapes": shapes })).starts_with("shapes[8][2]: "));
    }

    /// No config has as many settings as this `data` has fields. Reading it
    /// again once per field would cost its size squared; the reason stands
    /// without a setting instead.
    #[test]
    fn an_object_with_more_fields_than_any_config_has_is_not_searched() {
        let mut data = serde_json::Map::new();
        for index in 0..5000 {
            data.insert(format!("extra{index}"), json!(index));
        }
        data.insert("pin".into(), json!("left"));

        let (reason, rereads) = located(&serde_json::Value::Object(data));

        assert_eq!(reason, "invalid type: string \"left\", expected u8");
        assert_eq!(rereads, 0);
    }

    #[test]
    fn a_setting_among_as_many_fields_as_a_config_can_have_is_named() {
        let mut data = serde_json::Map::new();
        for index in 0..MAX_FIELDS_SEARCHED - 1 {
            data.insert(format!("extra{index}"), json!(index));
        }
        data.insert("pin".into(), json!("left"));

        let (reason, _) = located(&serde_json::Value::Object(data));

        assert_eq!(reason, "pin: invalid type: string \"left\", expected u8");
    }

    #[derive(Debug, Deserialize)]
    #[allow(dead_code)]
    #[serde(rename_all = "lowercase")]
    enum Gate {
        And,
        Or,
    }

    #[derive(Debug, Deserialize)]
    #[allow(dead_code)]
    struct Wordy {
        #[serde(default)]
        label: Option<u8>,
        #[serde(default)]
        gate: Option<Gate>,
        #[serde(default, deserialize_with = "serde_utils::deserialize_optional_pin_u8")]
        pin: Option<u8>,
    }

    fn wordy(data: serde_json::Value) -> String {
        resolve::<Wordy>(&data).unwrap_err().to_string()
    }

    /// A reason is shown in the editor (Node health, the Sketch's problems),
    /// and the value it quotes is whatever the Flow holds: a pasted page of
    /// text as much as a typo. The setting is named whole; of the value, the
    /// first 40 characters are shown.
    #[test]
    fn a_long_value_is_quoted_by_its_start_only() {
        let long = "x".repeat(10_000);
        let start = "x".repeat(40);

        assert_eq!(
            wordy(json!({ "label": long })),
            format!("label: invalid type: string \"{start}…\", expected u8")
        );
        assert_eq!(
            wordy(json!({ "gate": long })),
            format!("gate: unknown variant `{start}…`, expected `and` or `or`")
        );
    }

    #[test]
    fn a_value_of_40_characters_is_quoted_whole_and_escapes_do_not_end_it_early() {
        let exact = "y".repeat(40);
        assert_eq!(
            wordy(json!({ "label": exact })),
            format!("label: invalid type: string \"{exact}\", expected u8")
        );
        assert_eq!(
            wordy(json!({ "label": "say \"pin\" 4" })),
            "label: invalid type: string \"say \\\"pin\\\" 4\", expected u8"
        );
    }

    /// A reason that quotes its value without quotation marks is bounded as a
    /// whole.
    #[test]
    fn a_reason_is_never_longer_than_a_few_lines() {
        let reason = wordy(json!({ "pin": "z".repeat(10_000) }));

        assert!(reason.starts_with("pin: invalid pin: zzzz"), "{reason}");
        assert!(reason.ends_with("zzzz…"), "{reason}");
        assert_eq!(reason.chars().count(), "pin: ".len() + MAX_REASON + 1);
    }

    /// Characters, not bytes: a cut never lands inside one.
    #[test]
    fn a_long_value_of_wide_characters_is_cut_between_characters() {
        let start = "é".repeat(40);
        assert_eq!(
            wordy(json!({ "label": "é".repeat(500) })),
            format!("label: invalid type: string \"{start}…\", expected u8")
        );
        assert!(wordy(json!({ "pin": "é".repeat(500) })).ends_with("éé…"));
    }

    #[test]
    fn data_that_is_not_an_object_is_unreadable_with_no_setting_to_name() {
        let unreadable = resolve::<Config>(&json!("pin 4")).unwrap_err();
        assert!(unreadable.to_string().starts_with("invalid type: string \"pin 4\""), "{unreadable}");
        assert!(resolve::<Config>(&serde_json::Value::Null).is_err());
    }
}
