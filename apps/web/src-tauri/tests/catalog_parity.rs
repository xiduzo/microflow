//! Catalog Parity Guard (ADR-0007) + wire-interface generator.
//!
//! Two things a node declares on both sides of the TypeScript↔Rust boundary
//! are held together here: its wire interface (Rust is the source) and its
//! config (the editor's `data` is the contract).
//!
//! ## Wire interface
//!
//! Each node's Rust `ports()`/`emits()` consts are the **single source of
//! truth** for its wire interface. This test keeps the frontend in lockstep by
//! *generating* — not hand-mirroring — the catalog's wire data:
//!
//!   - With `BLESS_WIRE_INTERFACE=1` it (re)writes
//!     `apps/web/wire-interface.generated.json` from
//!     `ComponentRegistry::declared()`. The frontend codegen
//!     (`scripts/codegen-node-registry.ts`) reads that file to emit
//!     `COMPONENT_PORTS` / `COMPONENT_EMITS`, so the TS literal-unions derive
//!     from Rust *by construction* — there is no hand-authored
//!     `impls[].ports/emits` mirror left to drift. (This is the live successor
//!     to the `build.rs` port-drift codegen dropped in the re-host, ADR-0006.)
//!   - Without the env var it asserts the committed sidecar is current, so a
//!     stale file fails CI instead of silently shipping wrong handle types.
//!   - It always asserts every catalog `entries[].name` is a registered
//!     (buildable) node — no orphan entries, no orphan registrations.
//!
//! ## Node config
//!
//! A node's settings are authored by its TypeScript schema, travel as
//! `node.data`, and are read into its Rust config by one step,
//! `microflow_core::config::resolve`, for the live runtime and the Arduino
//! export alike. The frontend codegen reads off every entry's schema what the
//! editor writes — a new node's defaults, each variant's defaults, every
//! option of every enum field — into `apps/web/node-defaults.generated.json`;
//! this guard feeds all of it through that resolution and fails when:
//!
//!   - any of it cannot be read (the runtime would not run the node, the
//!     export would refuse it) — an option the Rust enum spells differently;
//!   - the editor's default for a field differs from the Rust config's own
//!     default, unless recorded in [`DELIBERATE_DIFFERENCES`];
//!   - a config field is spelled differently from what the editor writes (the
//!     serde camelCase trap), so the field would silently keep its default;
//!   - a number with a fraction in an integer setting (the editor's numeric
//!     inputs can store `25.2`) is not read as the nearest whole number by
//!     both halves, or a value the setting cannot hold is not refused by both;
//!   - a setting the defaults show nothing of (absent, or a list that starts
//!     empty) has no value listed in [`HIDDEN_BY_DEFAULT`] to check it with.
//!
//! The editor's shape wins a disagreement: saved flows already carry it.
//!
//! A build script cannot introspect Rust trait impls, so this runs as a normal
//! test. This crate is the one place that enables every core feature at once
//! (`js`, so `Function` is present; `cloud`, so `Mqtt`/`Llm`/`Figma` are), so
//! `declared()` here is the complete node set — aliases (`Vibration`/`Force`/…)
//! included.

use std::collections::{BTreeMap, BTreeSet};

use microflow_core::codegen::board::{target_by_id, BoardTarget};
use microflow_core::codegen::generate;
use microflow_core::codegen::validate::ProblemSeverity;
use microflow_core::flow::{FlowNode, FlowUpdate, Position};
use microflow_core::runtime::ComponentRegistry;
use serde::Deserialize;
use serde_json::{json, Value};

const MANIFEST: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../node-components.json");
const DEFAULTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../node-defaults.generated.json");
const SIDECAR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../wire-interface.generated.json");

fn read_json(path: &str) -> Value {
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{path} is valid JSON: {e}"))
}

/// `{ entryName: { "ports": [...], "emits": [...] } }`, sorted by name, built
/// from the Rust impls' declared wire interface. Keyed by registration name, so
/// alias entries (`Force`/`Vibration`/…) carry their parent impl's interface —
/// matching what the codegen looks up per `entries[].name`. Handle order is the
/// Rust declaration order from `ports()`/`emits()`.
fn wire_interface_from_rust() -> Value {
    let registry = ComponentRegistry::new();
    let mut by_name: BTreeMap<String, Value> = BTreeMap::new();
    for (name, (ports, emits)) in registry.declared() {
        by_name.insert(name.clone(), json!({ "ports": ports, "emits": emits }));
    }
    serde_json::to_value(by_name).expect("wire interface serializes")
}

#[test]
fn wire_interface_sidecar_matches_rust() {
    let expected = wire_interface_from_rust();

    if std::env::var_os("BLESS_WIRE_INTERFACE").is_some() {
        let pretty = serde_json::to_string_pretty(&expected).expect("serialize wire interface");
        std::fs::write(SIDECAR, format!("{pretty}\n"))
            .unwrap_or_else(|e| panic!("write {SIDECAR}: {e}"));
        eprintln!("blessed {SIDECAR}");
        return;
    }

    let on_disk = read_json(SIDECAR);
    assert_eq!(
        on_disk, expected,
        "wire-interface.generated.json is stale.\n  \
         Regenerate from Rust: \
         `BLESS_WIRE_INTERFACE=1 cargo test --manifest-path apps/web/src-tauri/Cargo.toml --test catalog_parity`\n  \
         then `bun run codegen` in apps/web.",
    );
}

#[test]
fn every_catalog_entry_is_buildable() {
    let cat = read_json(MANIFEST);
    let entry_names: BTreeSet<String> = cat["entries"]
        .as_array()
        .expect("entries must be an array")
        .iter()
        .map(|e| e["name"].as_str().expect("entry.name").to_string())
        .collect();

    let registry = ComponentRegistry::new();
    let registered: BTreeSet<String> = registry.declared().keys().cloned().collect();

    assert_eq!(
        registered, entry_names,
        "registered names != catalog entries[].name\n  only in Rust: {:?}\n  only in catalog: {:?}",
        registered.difference(&entry_names).collect::<Vec<_>>(),
        entry_names.difference(&registered).collect::<Vec<_>>(),
    );
}

// ---- Node config parity: the editor's `data` against the Rust configs ------

/// What the editor writes into one catalog entry's `data`, read off the
/// entry's zod schema by `scripts/node-defaults.ts`.
#[derive(Deserialize)]
struct EditorData {
    /// The settings of a newly placed node.
    defaults: Value,
    /// For a schema with variants (Piezo's buzz/song): each one's selecting
    /// fields and its own defaults.
    variants: Vec<Variant>,
    /// Every value of every enum field, as a patch on `defaults`.
    options: Vec<Value>,
}

#[derive(Deserialize)]
struct Variant {
    select: Value,
    defaults: Value,
}

/// `node-defaults.generated.json`, by entry name. Generated by
/// `scripts/codegen-node-registry.ts`; `scripts/node-defaults.test.ts` keeps
/// the committed file current.
fn editor_data() -> BTreeMap<String, EditorData> {
    serde_json::from_value(read_json(DEFAULTS))
        .expect("node-defaults.generated.json maps entry names to { defaults, variants, options }")
}

/// `data` with `patch`'s fields set on it.
fn patched(data: &Value, patch: &Value) -> Value {
    let mut data = data.clone();
    if let (Some(data), Some(patch)) = (data.as_object_mut(), patch.as_object()) {
        data.extend(patch.clone());
    }
    data
}

/// The config fields whose editor default deliberately differs from the Rust
/// config's own default, as `(entry, field, why)`. Everything else must agree.
/// An entry that no longer differs fails the guard, so this list cannot go
/// stale.
const DELIBERATE_DIFFERENCES: &[(&str, &str, &str)] = &[
    (
        "Compare",
        "subValidator",
        "the same comparison under two names: the editor names each validator's first option, \
         the config leaves it empty, and empty means that first option",
    ),
    ("Matrix", "shapes", "a new matrix starts with one drawn shape; a node without shapes shows nothing"),
    ("Midi", "song", "a new node starts with a demo melody; a node without a song plays nothing"),
    ("Piezo", "song", "the song type starts with a demo melody; a node without a song plays nothing"),
    ("Pixel", "presets", "a new strip starts with one empty preset to fill in"),
    ("Tilt", "threshold", "a Variant default: a tilt switch only reports swings of 10 or more"),
];

/// Every `path` (dot-separated) at which two resolved configs differ.
fn differences(path: &str, editor: &Value, own: &Value, out: &mut Vec<String>) {
    match (editor, own) {
        (Value::Object(editor), Value::Object(own)) => {
            for (key, own_value) in own {
                let path = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                differences(&path, editor.get(key).unwrap_or(&Value::Null), own_value, out);
            }
        }
        _ if editor != own => out.push(path.to_string()),
        _ => {}
    }
}

/// A field name with its casing and separators removed: `read_length`,
/// `readLength` and `read-length` are the same field spelled three ways.
fn spelled_out(key: &str) -> String {
    key.chars().filter(char::is_ascii_alphanumeric).flat_map(char::to_lowercase).collect()
}

/// Every config field (by `path`) the editor writes under another spelling
/// than the config reads — the serde `rename_all = "camelCase"` trap, where
/// the field then silently keeps its default.
fn misspellings(path: &str, config: &Value, data: &Value, out: &mut Vec<String>) {
    let (Value::Object(config), Value::Object(data)) = (config, data) else {
        return;
    };
    for (key, value) in config {
        let here = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
        if let Some(written) = data.get(key) {
            misspellings(&here, value, written, out);
        } else if let Some(written) = data.keys().find(|k| spelled_out(k) == spelled_out(key)) {
            out.push(format!("`{here}` (the editor writes `{written}`)"));
        } else if key.contains('_') {
            out.push(format!("`{here}` (snake_case, and the editor does not write it)"));
        }
    }
}

/// Why `data` cannot be read as an `entry` node by either half of the engine:
/// the live runtime builds it (interpret) and the Arduino export generates it
/// (emit), each through `microflow_core::config::resolve`.
fn unreadable(registry: &ComponentRegistry, target: &BoardTarget, entry: &str, data: &Value) -> Vec<String> {
    let mut reasons = Vec::new();
    if let Err(e) = registry.create("n", entry, data) {
        reasons.push(format!("the runtime cannot build it: {e}"));
    }
    reasons.extend(sketch_errors(target, entry, data).into_iter().map(|error| format!("no sketch: {error}")));
    reasons
}

/// The error-severity problems that refuse a sketch of one `entry` node.
fn sketch_errors(target: &BoardTarget, entry: &str, data: &Value) -> Vec<String> {
    let flow = FlowUpdate {
        nodes: vec![FlowNode {
            id: "n".to_string(),
            node_type: Some(entry.to_string()),
            data: data.clone(),
            position: Position { x: 0.0, y: 0.0 },
        }],
        edges: vec![],
    };
    let outcome = generate(&flow, target).expect("generation never errors");
    outcome
        .problems
        .into_iter()
        .filter(|p| p.severity == ProblemSeverity::Error)
        .map(|p| p.message)
        .collect()
}

/// Everything the editor can write into a node's `data` — a new node's
/// defaults, each variant's defaults, every option of every enum field — must
/// be readable by both halves of the engine.
#[test]
fn everything_the_editor_writes_is_readable() {
    let registry = ComponentRegistry::new();
    let target = target_by_id("esp32").expect("esp32 is a board target");
    let editor = editor_data();
    assert_eq!(
        editor.keys().cloned().collect::<BTreeSet<_>>(),
        registry.declared().keys().cloned().collect::<BTreeSet<_>>(),
        "node-defaults.generated.json does not list the registered entries — run `bun run codegen` in apps/web",
    );

    let mut failures = Vec::new();
    for (entry, data) in &editor {
        let mut check = |what: String, data: &Value| {
            for reason in unreadable(&registry, &target, entry, data) {
                failures.push(format!("{entry} {what}: {reason}"));
            }
        };
        check("with its defaults".to_string(), &data.defaults);
        for variant in &data.variants {
            check(format!("as {}", variant.select), &patched(&data.defaults, &variant.defaults));
        }
        for option in &data.options {
            check(format!("set to {option}"), &patched(&data.defaults, option));
        }
    }
    assert!(
        failures.is_empty(),
        "the engine cannot read what the editor writes; fix the Rust config (the editor's shape is \
         the contract saved flows carry):\n  {}",
        failures.join("\n  "),
    );
}

/// The editor's defaults and the Rust config's own defaults are the same
/// values: what a new node shows is what a node without that field does. For a
/// variant, its defaults against a node that only selects the variant.
/// `resolved_config` reads both through the same resolution, so a pin the
/// editor writes as `"8"` and the config holds as `8` are equal here.
#[test]
fn editor_defaults_equal_the_configs_own_defaults() {
    let registry = ComponentRegistry::new();
    let mut differing: BTreeSet<(String, String)> = BTreeSet::new();
    for (entry, data) in &editor_data() {
        let nothing_set = json!({});
        let pairs = std::iter::once((&data.defaults, &nothing_set))
            .chain(data.variants.iter().map(|variant| (&variant.defaults, &variant.select)));
        for (editor, own) in pairs {
            // Unreadable data is `everything_the_editor_writes_is_readable`'s to report.
            let (Ok(editor), Ok(own)) =
                (registry.resolved_config(entry, editor), registry.resolved_config(entry, own))
            else {
                continue;
            };
            let mut paths = Vec::new();
            differences("", &editor, &own, &mut paths);
            differing.extend(paths.into_iter().map(|path| (entry.clone(), path)));
        }
    }

    let seeded: BTreeSet<(String, String)> =
        DELIBERATE_DIFFERENCES.iter().map(|(entry, field, _)| ((*entry).to_string(), (*field).to_string())).collect();
    assert!(
        differing.is_subset(&seeded),
        "the editor's default differs from the Rust config's default; align the Rust config with \
         the editor (its default is what a new node shows), or record the difference in \
         DELIBERATE_DIFFERENCES:\n  {:?}",
        differing.difference(&seeded).collect::<Vec<_>>(),
    );
    assert!(
        seeded.is_subset(&differing),
        "DELIBERATE_DIFFERENCES lists fields that no longer differ — remove them:\n  {:?}",
        seeded.difference(&differing).collect::<Vec<_>>(),
    );
    assert!(DELIBERATE_DIFFERENCES.iter().all(|(_, _, why)| !why.is_empty()));
}

/// Every config field is spelled the way the editor writes it. A Rust field
/// that reads `read_length` while the editor writes `readLength` never errors:
/// it silently keeps its default.
#[test]
fn config_fields_are_spelled_as_the_editor_writes_them() {
    let registry = ComponentRegistry::new();
    let mut misspelled = BTreeSet::new();
    for (entry, data) in &editor_data() {
        let Ok(config) = registry.resolved_config(entry, &json!({})) else {
            continue; // a config with required fields: nothing to compare against
        };
        // Everything the editor writes for this entry, variants included.
        let written = data.variants.iter().fold(data.defaults.clone(), |all, v| patched(&all, &v.defaults));
        let mut fields = Vec::new();
        misspellings("", &config, &written, &mut fields);
        misspelled.extend(fields.into_iter().map(|field| format!("{entry}: {field}")));
    }
    assert!(
        misspelled.is_empty(),
        "config fields the editor's `data` never reaches; rename the Rust field's wire name \
         (`#[serde(rename_all = \"camelCase\")]`, or `rename` for one field):\n  {misspelled:?}",
    );
}

/// One step into a config: a field, or an element of a list.
#[derive(Clone)]
enum Step {
    Field(String),
    Element(usize),
}

fn path_name(path: &[Step]) -> String {
    let steps: Vec<String> = path
        .iter()
        .map(|step| match step {
            Step::Field(field) => format!(".{field}"),
            Step::Element(index) => format!("[{index}]"),
        })
        .collect();
    steps.concat().trim_start_matches('.').to_string()
}

/// Every integer in a resolved `config`, with its path. An `f64` setting
/// serializes with its fraction (`1000.0`), so an integer here is an integer
/// field of the Rust config. Of a list, the first element stands for all.
fn integer_settings(path: &mut Vec<Step>, config: &Value, out: &mut Vec<(Vec<Step>, u64)>) {
    match config {
        Value::Number(number) => {
            if let Some(value) = number.as_u64() {
                out.push((path.clone(), value));
            }
        }
        Value::Object(fields) => {
            for (field, value) in fields {
                path.push(Step::Field(field.clone()));
                integer_settings(path, value, out);
                path.pop();
            }
        }
        Value::Array(elements) => {
            if let Some(first) = elements.first() {
                path.push(Step::Element(0));
                integer_settings(path, first, out);
                path.pop();
            }
        }
        _ => {}
    }
}

/// The settings the defaults hide from [`integer_settings`]: one that is
/// absent by default (an `Option`, resolved as `null`), and the elements of a
/// list that is empty by default. Nothing in a resolved config says what is
/// behind either, so each is listed with a value a Flow carries there, as
/// `(entry, setting, the value as JSON)`. The guard writes the value into the
/// defaults and checks what then shows, like any other setting.
///
/// A hidden setting without an entry fails the guard (a node gained an
/// optional setting or a list: list a value for it), and so does an entry for
/// a setting that is not hidden, so this list cannot go stale.
const HIDDEN_BY_DEFAULT: &[(&str, &str, &str)] = &[
    ("Music", "tracks", r#"[{ "name": "chime.mp3", "src": "data:audio/mpeg;base64,AAAA" }]"#),
    ("Piezo", "song", r#"[["A4", 0.25]]"#),
    ("Pixel", "presets[0]", r##"["#ff0000"]"##),
    ("Stepper", "enablePin", "8"),
];

/// Every setting of a resolved `config` that shows nothing of what it holds:
/// a `null`, an empty list. Of a list, the first element stands for all.
fn hidden_settings(path: &mut Vec<Step>, config: &Value, out: &mut Vec<Vec<Step>>) {
    match config {
        Value::Null => out.push(path.clone()),
        Value::Object(fields) => {
            for (field, value) in fields {
                path.push(Step::Field(field.clone()));
                hidden_settings(path, value, out);
                path.pop();
            }
        }
        Value::Array(elements) => match elements.first() {
            None => out.push(path.clone()),
            Some(first) => {
                path.push(Step::Element(0));
                hidden_settings(path, first, out);
                path.pop();
            }
        },
        _ => {}
    }
}

/// `defaults` with the value [`HIDDEN_BY_DEFAULT`] lists written into every
/// setting they hide, and into every setting those values hide in turn.
/// `used` collects the entries of the list that were needed; a hidden setting
/// without one, or one whose value shows nothing either, is a failure.
fn with_hidden_settings_shown(
    registry: &ComponentRegistry,
    entry: &str,
    defaults: &Value,
    used: &mut BTreeSet<(String, String)>,
    failures: &mut Vec<String>,
) -> Value {
    let mut data = defaults.clone();
    let mut shown: BTreeSet<String> = BTreeSet::new();
    loop {
        let config = match registry.resolved_config(entry, &data) {
            Ok(config) => config,
            Err(refusal) => {
                failures.push(format!(
                    "{entry}: with the values HIDDEN_BY_DEFAULT lists for {shown:?} it cannot be read: {refusal}"
                ));
                return defaults.clone();
            }
        };
        let mut hidden = Vec::new();
        hidden_settings(&mut Vec::new(), &config, &mut hidden);
        let mut wrote = false;
        for path in hidden {
            let setting = path_name(&path);
            if shown.contains(&setting) {
                failures.push(format!(
                    "{entry} `{setting}`: the value HIDDEN_BY_DEFAULT lists for it shows nothing either"
                ));
                continue;
            }
            shown.insert(setting.clone());
            let Some((_, _, value)) =
                HIDDEN_BY_DEFAULT.iter().find(|(of, hidden, _)| *of == entry && *hidden == setting)
            else {
                failures.push(format!(
                    "{entry} `{setting}`: absent or empty by default, so this guard cannot see what it \
                     holds; list a value for it in HIDDEN_BY_DEFAULT"
                ));
                continue;
            };
            let value = serde_json::from_str(value)
                .unwrap_or_else(|e| panic!("HIDDEN_BY_DEFAULT {entry} `{setting}` is valid JSON: {e}"));
            data = written(&data, &path, value);
            used.insert((entry.to_string(), setting));
            wrote = true;
        }
        if !wrote {
            return data;
        }
    }
}

/// `data` with the setting at `path` written as `value`.
fn written(data: &Value, path: &[Step], value: Value) -> Value {
    let mut data = data.clone();
    let mut at = &mut data;
    for step in path {
        at = match step {
            Step::Field(field) => {
                if !at.is_object() {
                    *at = json!({});
                }
                at.as_object_mut().expect("an object").entry(field.clone()).or_insert(Value::Null)
            }
            Step::Element(index) => at.get_mut(*index).expect("the list the config was resolved from"),
        };
    }
    *at = value;
    data
}

fn read_at<'a>(config: &'a Value, path: &[Step]) -> Option<&'a Value> {
    path.iter().try_fold(config, |at, step| match step {
        Step::Field(field) => at.get(field),
        Step::Element(index) => at.get(index),
    })
}

/// The editor's numeric inputs store JSON numbers, and a dragged, typed or
/// pasted one may carry a fraction. For every integer setting of every entry,
/// those the defaults hide included ([`HIDDEN_BY_DEFAULT`]):
///
/// - a fraction is read as the nearest whole number by the runtime, and the
///   export generates — unless the setting is a pin, which is a name: both
///   halves refuse pin 13.4;
/// - a value the setting cannot hold (negative, or past its type) is refused by
///   both halves, never wrapped.
#[test]
#[allow(clippy::cast_precision_loss)]
fn a_number_in_an_integer_setting_means_the_same_to_both_halves() {
    let registry = ComponentRegistry::new();
    let target = target_by_id("esp32").expect("esp32 is a board target");
    let mut failures = Vec::new();
    let (mut rounded, mut pins) = (0, 0);
    let mut hidden_used = BTreeSet::new();
    for (entry, data) in &editor_data() {
        if registry.resolved_config(entry, &data.defaults).is_err() {
            continue; // unreadable: `everything_the_editor_writes_is_readable` reports it
        }
        // An entry the export writes as a placeholder never reads its settings.
        let export_reads_settings = !sketch_errors(&target, entry, &json!("not settings")).is_empty();
        // The defaults, then the defaults with what they hide written in.
        let shown =
            with_hidden_settings_shown(&registry, entry, &data.defaults, &mut hidden_used, &mut failures);
        let mut checked = BTreeSet::new();
        for base in [&data.defaults, &shown] {
            let Ok(config) = registry.resolved_config(entry, base) else {
                continue;
            };
            let mut settings = Vec::new();
            integer_settings(&mut Vec::new(), &config, &mut settings);
            for (path, value) in settings {
                if !checked.insert(path_name(&path)) {
                    continue;
                }
                let name = format!("{entry} `{}`", path_name(&path));

                // Rounds back to `value`; truncating would not (for a value of 1 or more).
                let fraction = if value >= 1 { value as f64 - 0.4 } else { 0.4 };
                let data_with_fraction = written(base, &path, json!(fraction));
                let export_refuses = !sketch_errors(&target, entry, &data_with_fraction).is_empty();
                match registry.resolved_config(entry, &data_with_fraction) {
                    Ok(read) => {
                        rounded += 1;
                        if read_at(&read, &path) != Some(&json!(value)) {
                            failures.push(format!(
                                "{name}: {fraction} is read as {:?}, not {value}",
                                read_at(&read, &path)
                            ));
                        }
                        if export_refuses {
                            failures
                                .push(format!("{name}: the runtime reads {fraction}, the export refuses it"));
                        }
                    }
                    Err(refusal) => {
                        pins += 1;
                        if !refusal.to_string().contains("invalid pin") {
                            failures.push(format!(
                                "{name}: {fraction} must be read as {value} — only a pin refuses a \
                                 fraction — but: {refusal}"
                            ));
                        }
                        if export_reads_settings && !export_refuses {
                            failures
                                .push(format!("{name}: the runtime refuses {fraction}, the export reads it"));
                        }
                    }
                }

                for out_of_range in [json!(-1), json!(-7.5), json!(1e30)] {
                    let data = written(base, &path, out_of_range.clone());
                    if let Ok(read) = registry.resolved_config(entry, &data) {
                        failures.push(format!(
                            "{name}: {out_of_range} must be refused, but is read as {:?}",
                            read_at(&read, &path)
                        ));
                    }
                    if export_reads_settings && sketch_errors(&target, entry, &data).is_empty() {
                        failures.push(format!("{name}: the export must refuse {out_of_range}"));
                    }
                }
            }
        }
    }
    for (entry, setting, _) in HIDDEN_BY_DEFAULT {
        if !hidden_used.contains(&((*entry).to_string(), (*setting).to_string())) {
            failures.push(format!(
                "{entry} `{setting}`: listed in HIDDEN_BY_DEFAULT, but the defaults do not hide it — remove it"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "an integer config field must read through `config::serde_utils` (`deserialize_whole` for \
         a setting, `deserialize_pin_u8` for a pin), and HIDDEN_BY_DEFAULT must list exactly the \
         settings the defaults hide:\n  {}",
        failures.join("\n  "),
    );
    assert!(rounded > 0 && pins > 0, "the guard found {rounded} settings and {pins} pins to check");
}
