//! Catalog Parity Guard (ADR-0007) + wire-interface generator.
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
//! A build script cannot introspect Rust trait impls, so this runs as a normal
//! test. This crate is the one place that enables every core feature at once
//! (`js`, so `Function` is present; `cloud`, so `Mqtt`/`Llm`/`Figma` are), so
//! `declared()` here is the complete node set — aliases (`Vibration`/`Force`/…)
//! included.

use std::collections::{BTreeMap, BTreeSet};

use microflow_core::runtime::ComponentRegistry;
use serde_json::{json, Value};

const MANIFEST: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../node-components.json");
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
