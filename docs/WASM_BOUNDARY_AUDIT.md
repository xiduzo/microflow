# WASM boundary audit

Measured composition of the three browser wasm modules, and the measured cost of
the JSON string ABI on the runtime's hot paths.

All sizes in bytes, measured on macOS arm64, rustc 1.98.0, wasm-pack 0.13 with
wasm-bindgen 0.2.127 and binaryen `wasm-opt` 117. "gzip" is `gzip -9`, the
closest cheap proxy for what a CDN ships.

## Recommendations

| # | Recommendation | Number attached |
|---|---|---|
| 1 | **Do not merge the three crates.** Split `boa` out of the runtime module instead — gate the `js` feature behind a separately-loaded wasm module fetched only for flows containing a Function node. | Removing `js` takes the runtime module from **5,643,789 → 703,078** bytes (**−87.5%**; gzip 1,740,378 → 265,349, **−84.8%**). Merging all three saves **238,234** bytes total (−3.6%) and costs a codegen-only user **+5.8 MB**. |
| 2 | **The wasm modules build under `[profile.wasm-release]`** — `lto = true`, `opt-level = "s"`, `codegen-units = 1`, `panic = "abort"`, `strip = "debuginfo"`, scoped off the desktop build. See [Release profile](#release-profile). | Three modules total **6,619,951 → 4,437,290** bytes (**−33.0%**; gzip 2,116,792 → 1,554,931, **−26.5%**) with zero source changes. |
| 3 | **Keep the JSON string ABI on perf grounds.** Switch to `serde_wasm_bindgen` only if the argument is correctness — the twelve `JSON.parse` throw sites — not speed. | A representative 3-event turn costs **0.73 µs** to serialize plus **0.80 µs** to parse. At the 19 ms Firmata sampling interval that is **0.008 %** of wall clock; at a 1 ms interval it is **0.15 %**. |

Recommendations 1 and 2 compose: profile tuning plus a boa split puts the
always-loaded runtime module in the few-hundred-KB range.

## Question 1 — binary composition

### What ships today

| Module | Raw | gzip | Core features |
|---|---:|---:|---|
| `runtime/generated/microflow_runtime_wasm_bg.wasm` | 3,584,975 | 1,214,723 | `runtime, js, cloud` |
| `codegen/generated/microflow_codegen_wasm_bg.wasm` | 446,785 | 174,104 | default (none) |
| `firmata/generated/microflow_firmata_wasm_bg.wasm` | 405,530 | 166,104 | default (none) |
| **Total** | **4,437,290** | **1,554,931** | |

Built under [`[profile.wasm-release]`](#release-profile). The composition and
duplication figures below are stock-release builds — the profile scales all
three modules together, so the proportions they establish are unchanged.

### boa is 87.5 % of the runtime module

Built from an identical source tree, same toolchain, same command, differing
only in the `microflow-core` feature list:

| Runtime build | Raw | gzip |
|---|---:|---:|
| `runtime, js, cloud` | 5,657,951 | 1,747,008 |
| `runtime, cloud` (no `js`) | 703,078 | 265,349 |
| **boa (`js`) delta** | **4,954,873 (87.6 %)** | **1,481,659 (84.8 %)** |

`js` gates only the Function node's embedded JS engine
(`crates/microflow-core/Cargo.toml`, `js = ["runtime", "dep:boa_engine"]`).
Every browser session that connects a board downloads the whole VM, whether or
not the flow contains a Function node.

`twiggy top` on the shipped module reports item indices (`code[23]`,
`data[1148]`), not names — the release build carries no name section, so
per-crate attribution from the binary alone is not available. The feature diff
above is the measurement that stands.

### Genuine duplication across the three binaries

Measured by building merged crates that expose the same `#[wasm_bindgen]`
surfaces from a single module, and diffing against the sum of the separates.

| Combination | Separate sum | Merged | Duplication removed |
|---|---:|---:|---:|
| codegen + firmata | 976,162 | 886,661 | **89,501 (9.2 %)** |
| codegen + firmata, gzip | 376,414 | 331,463 | 44,951 (11.9 %) |
| all three | 6,619,951 | 6,381,717 | **238,234 (3.6 %)** |
| all three, gzip | 2,116,792 | 2,009,006 | 107,786 (5.1 %) |

For context, a minimal crate that links `microflow-core` (default features) and
does nothing but round-trip a `FlowUpdate` through serde compiles to **132,302**
bytes (gzip 61,405). That is the wasm-bindgen + `std` + `serde_json` + flow
read-model floor each module pays.

Duplication is real but small: **238 KB raw / 108 KB gzip across the whole
surface**, against a 4.95 MB boa payload. The shared core is mostly
dead-code-eliminated per binary — codegen keeps the emitters and drops the
runtime; firmata keeps the codec and flasher and drops both.

### Build configuration

| Question | Answer | Evidence |
|---|---|---|
| Release or debug? | Release | `wasm-pack build --profile wasm-release`, which inherits `release` |
| Does `wasm-opt` run? | Yes, with `-O` | Build log: ``Optimizing wasm binaries with `wasm-opt`…``; binary at `~/Library/Caches/.wasm-pack/wasm-opt-*/bin/wasm-opt` |
| Any `[profile.*]` overrides? | `[profile.wasm-release]` in the workspace root, used by the wasm builds only. `[profile.release]` is stock, so the native desktop build is unaffected | `Cargo.toml`; `apps/web/package.json` `build:wasm:*` |
| Any `[package.metadata.wasm-pack]`? | **None** in any crate — wasm-pack reads that table only for its three built-in profile names, and ignores it for a user-defined `--profile` | verified against wasm-pack 0.15.0 |

### Merging: what it saves, what it costs

Merging all three into one crate saves **238,234 raw / 107,786 gzip** bytes of
total transferred bytes, and costs each entry point the union of the other two.

| Page needs | Downloads today (gzip) | Downloads merged (gzip) | Delta |
|---|---:|---:|---:|
| Code view only (`generate_sketch`) | 206,704 | 2,009,006 | **+1,802,302** |
| Board connect, no flow run | 169,710 | 2,009,006 | +1,839,296 |
| Full session (all three) | 2,116,792 | 2,009,006 | −107,786 |

Only the third row wins, and only by 5 %. The other two regress by an order of
magnitude, and they include a browser-only user who never plugs in a board.

### Lazy loading

All three modules are **already lazy at the binary level**. Each `wasm.ts`
imports the `.wasm` through Vite's `?url`, which yields a string, and calls
`init({ module_or_path: wasmUrl })` from a memoised `ensureReady()`:

- `apps/web/src/lib/codegen/wasm.ts` — fetched on the first `generateSketch` / `checkCredentials`
- `apps/web/src/lib/firmata/wasm.ts` — fetched on the first Web Serial connect
- `apps/web/src/lib/runtime/wasm.ts` — fetched by `createFlowRuntime()`, called from `FlowReactor.attach`

Nothing but the JS glue (12,316 / 27,629 / 31,618 bytes, tree-shaken and
bundled) is on the critical path to first render. The 557 KB codegen binary
already costs nothing until the user opens the Code view.

So "lazy-load codegen instead of merging" is not an available move — it is the
current state. The equivalent unexploited move is the boa split: make the
Function node's engine its own module behind the same `?url` + `ensureReady`
pattern, loaded only when a flow contains a Function node.

## Question 2 — hot-path crossing cost

### Hot paths

| Site | Trigger | Rate |
|---|---|---|
| `apps/web/src/lib/firmata/web-serial.ts:226` | `JSON.parse(session.feed(value))` | every inbound serial chunk |
| `apps/web/src/lib/firmata/flow-reactor.ts:126` → `:147` | `feedBytes` → `JSON.parse(effectsJson)` | every inbound serial chunk |
| `apps/web/src/lib/firmata/flow-reactor.ts:200` | `wake` → `apply` → parse | per armed timer; oscillator re-arms at `REFRESH_MS = 1000 / 60` = 16 ms |
| `apps/web/src/lib/firmata/web-serial.ts:297` | `pinCount` re-parses the pin table | **handshake only** — the 100 ms loop is bounded by `CAPABILITY_TIMEOUT_MS` during connect, not steady state |
| `crates/microflow-core/src/flasher/driver.rs` `FlashStep` | one parse per step | thousands per flash, serialised behind 115200-baud serial I/O |

### Payload size

Derived from the serde shape in `crates/microflow-core/src/runtime/context.rs`
(`Effects`, `#[serde(rename_all = "camelCase")]`) and
`crates/microflow-core/src/runtime/value.rs` (`ComponentEvent`).

A single event serialises as:

```json
{"source":"node-0-2f8a1c","sourceHandle":"value","value":512.0,
 "edgeId":"xy-edge__node-0-2f8a1cvalue-target_a","sequence":42}
```

| Turn | Payload |
|---|---:|
| empty (`Effects::default`) | 113 B |
| 1 event | 238 B |
| 3 events (three analog sensors reporting) | 490 B |
| 3 events + 6 outbound bytes | 513 B |
| 10 events | 1,372 B |
| 10 events + 64 outbound bytes | 1,627 B |
| 50 events (burst) | 6,492 B |

The empty-turn floor is 113 B of always-present empty arrays — every no-op
`feedBytes` still allocates and parses that.

`outboundBytes` crosses as a JSON array of decimal numbers: 256 bytes of serial
output become a 1,136-character string. Rebuilding it with `Uint8Array.from`
costs 2.98 µs for that case — the single most wasteful shape at the boundary,
roughly 4.4× the character cost of the equivalent event payload per useful byte.

### Round-trip cost

Rust side: `serde_json::to_string` on `Effects`, `cargo run --release`, native
arm64. TypeScript side: `JSON.parse` plus `Uint8Array.from(fx.outboundBytes)`,
`bun run`, 20 k warm-up iterations discarded.

| Turn | Rust serialize | TS parse + rebuild | Round trip |
|---|---:|---:|---:|
| empty | 0.138 µs | 0.159 µs | **0.30 µs** |
| 1 event | 0.321 µs | 0.335 µs | 0.66 µs |
| 3 events | 0.664 µs | 0.696 µs | **1.36 µs** |
| 3 events + 6 bytes | 0.725 µs | 0.802 µs | 1.53 µs |
| 10 events | 1.616 µs | 1.884 µs | 3.50 µs |
| 10 events + 64 bytes | 2.055 µs | 2.646 µs | 4.70 µs |
| 50 events (burst) | 13.176 µs | 8.662 µs | 21.84 µs |
| 256 outbound bytes, no events | — | 2.981 µs | — |

### Where it becomes measurable

Taking the 3-event turn (1.53 µs) as the representative steady-state cost and a
16.7 ms frame budget:

| Inbound rate | Round trips/s | Time/s | Share of wall clock | Share of one 16.7 ms frame |
|---|---:|---:|---:|---:|
| 19 ms sampling (Firmata default) | 53 | 81 µs | 0.008 % | 0.008 % |
| 16 ms oscillator tick | 63 | 96 µs | 0.010 % | 0.010 % |
| 19 ms sampling + 4 oscillators | 303 | 464 µs | 0.046 % | 0.046 % |
| 5 ms sampling | 200 | 306 µs | 0.031 % | 0.031 % |
| 1 ms sampling | 1,000 | 1,530 µs | 0.153 % | 0.153 % |
| 1 ms sampling, 10-event turns | 1,000 | 4,700 µs | 0.470 % | 0.470 % |

Reaching **1 % of a frame budget** takes roughly **6,500 three-event turns per
second**. Firmata at 115200 baud carries about 11,520 bytes/s; an analog report
is 3 bytes, so the wire tops out near 3,800 reports/s even with every other
message suppressed — and Web Serial delivers those in batched chunks, several
reports per `feedBytes` call, which lowers the turn count further.

The flasher is bounded by serial I/O, not JSON. A 32 KB sketch at 128-byte pages
is on the order of 1,000 `FlashStep`s; even at 5 µs each that is 5 ms inside a
multi-second flash.

### Verdict

**The perf argument is not real.** At every rate the hardware can produce, the
JSON round trip is under 0.5 % of wall clock, and the serial link saturates
roughly an order of magnitude before the boundary does. Switching to
`serde_wasm_bindgen` would not produce a user-visible change in the runtime's
responsiveness.

**The correctness argument is the whole case.** Twelve sites (excluding tests)
parse a string typed only by a TypeScript cast, so a malformed payload fails at
parse time rather than at compile time:

| Site | Failure mode |
|---|---|
| `firmata/web-serial.ts:226` | throws inside the read loop; the outer `catch` then treats it as a disconnect |
| `firmata/web-serial.ts:297`, `:302` | throws during the connect handshake |
| `firmata/web-serial.ts:459`, `:529` | throws mid-flash |
| `firmata/board-controller.ts:136` | throws inside the bring-up state machine |
| `firmata/flow-reactor.ts:147`, `:164`, `:172` | caught, logged, **the turn's effects are silently dropped** |
| `runtime/wasm.ts:53` | throws during Figma handshake reconcile |
| `codegen/wasm.ts:58`, `:77` | throws out of `generateSketch` / `checkCredentials` |

`flow-reactor.ts`'s three `catch` blocks are the sharp edge: a parse failure
there discards outbound bytes, timers, and cloud requests for that turn with
nothing but a `console.error`. `serde_wasm_bindgen` moves that class of failure
to the type system and removes the string intermediate.

## Release profile

The three browser modules build under `[profile.wasm-release]` in the workspace
root, selected by `apps/web/package.json`:

```
wasm-pack build ../../crates/microflow-<name>-wasm --profile wasm-release --target web
```

```toml
[profile.wasm-release]
inherits = "release"
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
strip = "debuginfo"
```

| Module | Raw | gzip |
|---|---:|---:|
| `runtime/generated/microflow_runtime_wasm_bg.wasm` | 3,584,975 | 1,214,723 |
| `codegen/generated/microflow_codegen_wasm_bg.wasm` | 446,785 | 174,104 |
| `firmata/generated/microflow_firmata_wasm_bg.wasm` | 405,530 | 166,104 |
| **Total** | **4,437,290** | **1,554,931** |

### Why the profile is scoped, not `[profile.release]`

`[profile.release]` is shared with the native desktop (Tauri) build, which CI
runs across four targets (mac arm64, mac x86, ubuntu, windows). A cold
`cargo build --release --manifest-path apps/web/src-tauri/Cargo.toml` takes
**1 m 28 s** on stock release and **3 m 16 s** with these settings applied to
`[profile.release]` — **2.2×**, per target, on a 16-core machine; `lto = true` +
`codegen-units = 1` serialise the link (CPU utilisation drops from 681 % to
225 %), so slower CI runners widen the gap. A desktop binary is installed once;
a wasm module is downloaded per session. Only the wasm side is worth the link
time.

wasm-pack learned `--profile` after 0.13; the workflows pin `v0.15.0`.

### Why `opt-level = "s"`

`"z"` is the smaller build and the slower one. Measured in the browser module
itself (bun, `--target web` glue initialised from the `.wasm` bytes), driving an
`Oscillator → Function` flow — `wake("_tick")` at the runtime's own 60 Hz
`REFRESH_MS`, each tick cascading into a `boa` evaluation:

| `opt-level` | Raw | gzip | µs/tick, Function node | µs/tick, oscillator only |
|---|---:|---:|---:|---:|
| `"z"` | 2,975,065 | 1,035,386 | 469 | 1.65 |
| `"s"` | 3,584,975 | 1,214,723 | 359 | 1.50 |
| `3` | 4,903,577 | 1,557,359 | 270 | 1.08 |

`"s"` costs 609,910 raw / 179,337 gzip bytes over `"z"` and returns **23 %** of
the Function node's per-tick time. The ordering reproduces across runs and holds
on the non-JS path too, so it is the code generator, not the JS workload. The
Function node builds a fresh `boa` `Context` per evaluation, which is what makes
that path expensive enough to care about at 60 Hz.

### Why `panic = "abort"`

On stable `wasm32-unknown-unknown` the panic strategy is already abort — real
unwinding needs a nightly `-Z build-std` rebuild of `std`, which is what
wasm-pack's separate `--panic-unwind` flag does. The profile key states what the
target does; it does not change it.

Measured on a probe crate exporting a panicking function, built once per panic
strategy and run under bun with `console.error` captured. `abort` and `unwind`
are indistinguishable:

| | `panic = "abort"` | `panic = "unwind"` |
|---|---|---|
| `console_error_panic_hook` output | full message + `src/lib.rs:10:5` + JS stack | identical |
| Thrown to JS | `RuntimeError: Unreachable code should not be executed` | identical |
| Module callable after the panic | yes | yes |
| Runtime module size | 2,975,065 | 2,975,543 |

The setting is worth 478 bytes and costs no diagnosability. Note the last row of
that table: a panic leaves the instance callable under both strategies, so a
host that needs to treat a panicked module as poisoned must track that itself —
neither panic strategy provides it.

### Why `strip = "debuginfo"`

`strip = true` also removes the `target_features` custom section. Without it
`wasm-opt` cannot see that the module is allowed bulk-memory operations, rejects
it with `Bulk memory operations require bulk memory [--enable-bulk-memory]`, and
the build fails before optimising anything. `strip = "debuginfo"` keeps the
section, so `wasm-opt` runs with plain `-O` from a cold cache and no
`--enable-*` flags need pinning. The alternative — `strip = true` plus six
pinned `--enable-*` flags — is worth 1,064 raw / 721 gzip bytes on the codegen
module (0.3 %), and wasm-pack ignores `[package.metadata.wasm-pack.profile.*]`
for user-defined profiles anyway.

## Method

Everything below re-derives the numbers. Scratch crates were built outside the
repo; no repo source was modified.

1. **Shipped sizes** — `cd apps/web && bun run build:wasm`, then `stat -f %z` on
   each `*_bg.wasm`, and `gzip -9 -c … | wc -c`.
2. **boa delta** — copy `crates/microflow-runtime-wasm` to a scratch directory
   twice, rewrite the `microflow-core` path dependency to an absolute path, add
   an empty `[workspace]` table, and in one copy change the feature list from
   `["runtime", "js", "cloud"]` to `["runtime", "cloud"]`. Build both with
   `wasm-pack build --target web`.
3. **Duplication** — assemble a scratch crate whose `src/` holds each wasm
   crate's `lib.rs` as a module (`codegen.rs`, `firmata.rs`, `runtime.rs`),
   keeping exactly one `#[wasm_bindgen(start)] pub fn init`. Build and compare
   against the sum of separates. Repeat with only `codegen` + `firmata` and
   `microflow-core` default features.
4. **Floor** — scratch crate depending on `microflow-core` (default features)
   exporting one function that serde round-trips a `FlowUpdate`.
5. **Profile variants** — sibling profiles inheriting `wasm-release` with only
   `opt-level` (or `panic`) changed, each built with
   `wasm-pack build crates/microflow-runtime-wasm --profile <name> --target web`
   into its own `CARGO_TARGET_DIR`.
5b. **Tick timing** — `bun` importing the `--target web` glue and calling
   `init({ module_or_path: <bytes> })`, then `updateFlow` on an
   `Oscillator → Function` graph and `wake("osc", "_tick", t)` in a loop;
   200 warm-up ticks discarded, median of five 3,000-tick samples.
5c. **Panic strategy** — a two-function probe crate (`console_error_panic_hook`
   in `#[wasm_bindgen(start)]`, one function that asserts) built `--target
   nodejs` under two profiles differing only in `panic`, run under bun with
   `console.error` captured.
5d. **Desktop compile time** — cold
   `cargo build --release --manifest-path apps/web/src-tauri/Cargo.toml` into an
   empty `CARGO_TARGET_DIR`, once with stock `[profile.release]` and once with
   the `wasm-release` settings copied onto it.
6. **Rust serialize timing** — scratch binary depending on `microflow-core`
   with `runtime, cloud`, constructing `Effects` directly (all fields are `pub`),
   `serde_json::to_string` in a loop under `cargo run --release`; 200 k
   iterations for small payloads, 50 k for the burst.
7. **TypeScript parse timing** — `bun run` on a script that `JSON.parse`s the
   same strings and rebuilds `outboundBytes` with `Uint8Array.from`, 20 k
   warm-up iterations discarded.

## Not measured

| Item | Why |
|---|---|
| Per-crate attribution inside the shipped binaries | `twiggy top`/`dominators` report `code[N]`/`data[N]` indices — the release build has no name section. A `debug = true` rebuild would restore names but change the sizes being attributed. |
| `serde_wasm_bindgen` round-trip timing | Would require adding the dependency and an alternative entry point to the runtime crate; this audit is read-only. The JSON round trip is already ≤0.5 % of wall clock, so the comparison cannot change the verdict. |
| In-wasm serialize timing | The Rust figures are native arm64. A wasm build is typically 1.5–3× slower, which at 3 events moves the round trip from 1.5 µs to at most ~3 µs — still under 0.02 % of wall clock at Firmata rates. |
| Real-device end-to-end latency | Needs a connected board; the audit is static plus microbenchmark. |
| Vite bundle impact of the JS glue | The glue files are 12,316 / 27,629 / 31,618 bytes pre-bundle; their post-tree-shake contribution to the initial chunk was not measured. |
| Effect of the in-flight `ts-rs` derives on `Effects` | The measurement tree carries uncommitted `#[derive(TS)]` additions on `Wakeup` / `CloudRequest` / `NodeDiagnostic`. They add binding code, not serde attributes, so the wire shape and all payload/timing figures are unaffected; binary sizes may shift by a small constant. |
| Brotli sizes | `gzip -9` was used as the transfer proxy; brotli would compress all rows further, roughly proportionally. |
