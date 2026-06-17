# Plan — Rust→WASM shared codegen (browser + desktop)

Goal: one Rust codegen implementation, callable from both the Tauri desktop app and the browser. Sets up a shared-core/platform-transport split so serial/Firmata protocol logic can move to the same WASM core later.

## Current state
- `apps/web/src-tauri` is a **standalone** crate (`app_lib`), no cargo workspace.
- `codegen/` (44 files, ~2700 lines) depends on the rest of the crate **only** via 4 pure serde structs: `FlowNode`, `FlowEdge`, `FlowUpdate`, `Position` (in `runtime/types.rs`). No Tauri, no async, no IO.
- No wasm toolchain (`wasm-pack`, `wasm32-unknown-unknown` target) installed. Vite has no wasm plugin.
- Frontend calls `generate_sketch` Tauri command via `lib/ipc.ts` → `@tauri-apps/api invoke`. No web fallback.

## Target architecture
```
/Cargo.toml                      [workspace] root  (members below)
crates/
  microflow-core/                pure: flow types (FlowNode/Edge/Update/Position) + codegen/
  microflow-codegen-wasm/        wasm-bindgen wrapper → generate_sketch(json) -> json
apps/web/src-tauri/              depends on microflow-core; runtime/types + codegen become re-exports
apps/web/src/lib/codegen/        web: load wasm pkg; isDesktop() ? invoke : wasm
```
- Desktop unchanged behaviourally: `app_lib` re-exports `microflow_core::{flow types, codegen}` so the ~80 `crate::runtime::types::` / `crate::codegen::` references keep compiling.
- All 455 codegen tests move with the crate (single source of truth, no drift).
- wasm wrapper: `#[wasm_bindgen] pub fn generate_sketch(flow_json, target_id, credentials_json) -> String` returning serialized `GenerationOutcome`. Credentials stay session-only (never persisted) — same as today.

## Phases
1. **Workspace + extract** — add root `[workspace]`, create `microflow-core`, move flow types + `codegen/`, re-export from `app_lib`. `cargo test` green, clippy clean. (no behaviour change)
2. **WASM crate** — `microflow-codegen-wasm`, wasm-bindgen wrapper, `wasm-pack build --target web`. Install toolchain (`rustup target add wasm32-unknown-unknown`, `wasm-pack`).
3. **Web wiring** — Vite wasm plugin, load pkg, `lib/codegen/` dispatcher: desktop→invoke, web→wasm. Code route works in browser.
4. **CI** — build wasm in the web pipeline; cache the wasm build.

## Future (not this change)
Firmata/serial: protocol codec + flow→command translation move into `microflow-core`; transport injected per platform — desktop `serialport`, browser **Web Serial API**.

## Genuine forks (need decision)
- **F1 — Workspace root**: repo-root `/Cargo.toml` workspace including `src-tauri` + `crates/*`, vs. nest crates under `apps/web/`.
- **F2 — WASM bundling**: `wasm-pack --target web` + `vite-plugin-wasm` (generated pkg imported by web), vs. inline the .wasm as an asset, vs. a committed prebuilt pkg.
- **F3 — Scope now**: do all 4 phases this run, or land Phase 1 (extract, zero behaviour change) first and review before the wasm/build-pipeline work.
