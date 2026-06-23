fn main() {
    // The runtime lives in `microflow-core`, which hand-registers nodes in
    // `ComponentRegistry::register_all`. The old codegen that parsed
    // `node-components.json` into a `register_all_body.rs` (carrying the
    // Rust↔catalog port-drift assertion) was dropped in the re-host (ADR-0006)
    // and nothing included it. The Rust↔catalog port/emit guard now lives as a
    // live test — `tests/catalog_parity.rs` (ADR-0007).
    tauri_build::build();
}
