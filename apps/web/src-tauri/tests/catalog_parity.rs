//! Catalog Parity Guard (ADR-0007).
//!
//! Asserts every node's Rust wire interface equals its declaration in
//! `apps/web/node-components.json`, in **both** directions:
//!   - `impls[].ports` ≡ `<Type>::ports()`
//!   - `impls[].emits` ≡ `<Type>::emits()`
//!   - the set of registered names ≡ `entries[].name` (every entry buildable,
//!     no orphan registrations).
//!
//! This is the live replacement for the `build.rs` port-drift assertion that
//! silently stopped running in the re-host (ADR-0006). It lives in the desktop
//! crate because that is the one place that enables every core feature at once
//! (`js`, so `Function` is present, and `cloud`, so `Mqtt`/`Llm`/`Figma` are).
//!
//! A build script cannot introspect Rust trait impls, so this runs as a normal
//! test: every node — core, aliases like `Vibration`/`Force`, and the sans-IO
//! cloud nodes — comes from `ComponentRegistry::declared()`, recorded at
//! registration in core's `register_all`.

use std::collections::{BTreeSet, HashMap};

use microflow_core::runtime::ComponentRegistry;
use serde_json::Value;

fn catalog() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../node-components.json");
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    serde_json::from_str(&raw).expect("node-components.json is valid JSON")
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

fn json_set(v: &Value) -> BTreeSet<String> {
    v.as_array()
        .expect("ports/emits must be an array")
        .iter()
        .map(|x| x.as_str().expect("each handle must be a string").to_string())
        .collect()
}

#[test]
fn catalog_matches_rust_ports_and_emits() {
    let cat = catalog();

    // Rust-declared (ports, emits) by registration name. Core's `register_all`
    // records every node — including the sans-IO cloud nodes (`Mqtt`/`Llm`/
    // `Figma`) under the `cloud` feature this crate enables — so the guard reads
    // them all uniformly from `declared()`.
    let registry = ComponentRegistry::new();
    let mut declared: HashMap<String, (BTreeSet<String>, BTreeSet<String>)> = HashMap::new();
    for (name, handles) in registry.declared() {
        declared.insert(name.clone(), (set(handles.0), set(handles.1)));
    }

    // (1) Forward parity: every catalog impl matches its Rust declaration.
    for im in cat["impls"].as_array().expect("impls must be an array") {
        let name = im["name"].as_str().expect("impl.name").to_string();
        let (rust_ports, rust_emits) = declared
            .get(&name)
            .unwrap_or_else(|| panic!("catalog impl `{name}` is not registered in Rust"));

        assert_eq!(
            &json_set(&im["ports"]),
            rust_ports,
            "PORT drift for `{name}` (catalog impls[].ports != Rust ports())"
        );

        let emits = im
            .get("emits")
            .unwrap_or_else(|| panic!("catalog impl `{name}` is missing the `emits` array"));
        assert_eq!(
            &json_set(emits),
            rust_emits,
            "EMIT drift for `{name}` (catalog impls[].emits != Rust emits())"
        );
    }

    // (2) No-orphan / buildability: registered names ≡ catalog entry names.
    let entry_names: BTreeSet<String> = cat["entries"]
        .as_array()
        .expect("entries must be an array")
        .iter()
        .map(|e| e["name"].as_str().expect("entry.name").to_string())
        .collect();
    let registered: BTreeSet<String> = declared.keys().cloned().collect();
    assert_eq!(
        registered,
        entry_names,
        "registered names != catalog entries[].name\n  only in Rust: {:?}\n  only in catalog: {:?}",
        registered.difference(&entry_names).collect::<Vec<_>>(),
        entry_names.difference(&registered).collect::<Vec<_>>(),
    );
}
