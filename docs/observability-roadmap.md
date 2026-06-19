# Observability Roadmap — logging & tracing

> Status: proposal / investigation result (2026-06-19). Candidate to become ADR 0006.
> Audited by walking all 4 surfaces (Rust crates, TS backend, frontend, architecture).

## TL;DR — current state

| Surface | What exists | Maturity | Killer gaps |
|---|---|---|---|
| **Rust** (`src-tauri`, `microflow-core`, 3× wasm) | `log 0.4`, 198 call sites, printf-style; `tauri-plugin-log` only under `debug_assertions` | **3/10** | Release builds emit **zero** logs; no structure; mqtt.rs logs-then-returns-`Ok(())`; codegen `.unwrap()`/`.expect()` panic hotspots |
| **TS backend** (Hono+tRPC+Bun, Yjs collab, MQTT) | raw `console.*` (35+), Hono `logger()` built-in fmt | **2/10** | No logger lib; no request/trace IDs; **silent `catch {}`** drops WS send errors (`collab/handler.ts:43-44,71-74`); drizzle queries invisible |
| **Frontend** (`web`, `fumadocs`, plugins) | 54× `console.*`, all ungated; Umami pageviews only | **2/10** | No Sentry / ErrorBoundary / `window.onerror`; logs ship to prod; no flow debug panel; no JS→Rust/backend forwarding |
| **Architecture** | clean actor + single drain choke-point | n/a | nothing instrumented at the choke-point yet |

**Answer to "is proper logging & tracing set up?": No.** Structured logging is absent; distributed tracing is absent; client error tracking is absent. What exists is unstructured, partly prod-invisible, and swallows errors in three known places.

## Implemented (2026-06-19): flow-runtime tracing (the choke-point)

The flow runtime emits structured `tracing` at the single drain choke-point — identical on desktop and browser, covering every stimulus (incl. async cloud results via `inject_event`).

- **`crates/microflow-core/src/runtime/mod.rs`** — `finish(stimulus, …)` opens a `flow_tick` span (`stimulus`, `seq`) and emits **one wide event per turn that did work** (gated on drained / bytes / wakeups / cancellations / errors, so idle pin-scans stay silent). Fields: `stimulus` (`update_flow`/`feed_bytes`/`wake`/`dispatch`/`deliver`/`inject`/`key`), `drained`, `component_events`, `outbound_bytes`, `wakeups`, `cancellations`, `errors`. `process_event()` adds opt-in `TRACE`: per-event `drain`, `routed` (fanout), `stale event dropped`. Dispatch failures are now a counted `tracing::warn!` (were `log::warn!`, invisible in the browser). No clock in core (wasm has no `Instant`) — subscribers do timing.
- **`crates/microflow-core`** — `tracing` always-on (like `log`); `tracing-test` dev-dep guards the wide event (`flow_turn_emits_the_flow_tick_wide_event`).
- **`crates/microflow-runtime-wasm`** — browser subscriber via **`tracing-web`** (maintained; replaced the abandoned `tracing-wasm`) on a `Registry`, plus a `tracing-log` bridge so the crate's existing `log::` records — previously dropped, the browser had no `log` subscriber at all — reach the console too. DEBUG dev / WARN release.
- **`apps/web/src-tauri`** — `tracing-subscriber` fmt in `run()`, `RUST_LOG`-driven (default `warn,microflow_core=debug`), separate from `tauri-plugin-log`. **Gotcha (fixed):** installed via `tracing::subscriber::set_global_default`, **not** `.init()` — `.init()` also installs a `log`→tracing `LogTracer` that claims the global `log` logger, which makes `tauri-plugin-log` panic at startup with *"attempted to set a logger after the logging system was already initialized."*

**Observe it:**
- Desktop: `RUST_LOG=microflow_core=debug bun tauri dev` → flow ticks on stdout. Per-event detail: `RUST_LOG=microflow_core=trace`.
- Browser: dev build + open console → `flow_tick` events as flows execute.

Verified: core / desktop / wasm32 compile + clippy-clean; 360 core tests pass (incl. the capture test).

## The answer — researched end-state for flow-runtime observability

Cross-checked against how mature flow/dataflow tools (Node-RED, n8n, ComfyUI, Temporal) and the Rust `tracing` ecosystem do this. THE correct end-state:

> **One `tracing` fan-out `Layer`, registered identically on both hosts (`tracing-web` on browser), emitting wide events at two grains — a tick-level canonical line (shipped above) nested under one `flow_tick` span, and a coarser flow-run/trigger-level event keyed by a `run_id` stamped on the originating stimulus — with per-node detail as high-cardinality fields, never child spans. That same Layer fans the per-node/per-edge events into a first-class in-app inspector (node status badges + debug sidebar + per-edge value watches, Node-RED `RED.comms` style), fed via the `Effects.component_events` already returned. Console and UI become two sinks of one pipeline.**

What the shipped work gets **right** (confirmed by the research): library-emits / host-subscribes; a single `flow_tick` span (do **not** make each node dispatch a child span — Honeycomb/OTel guidance); one wide event per working turn; deferring duration to the subscriber on wasm; per-event detail gated to opt-in `TRACE`.

### Shipped (full send, 2026-06-19)

1. **`run_id` correlation grain** — `finish()` stamps a monotonic `run_id` on the `flow_tick` span, the wide event, and every per-event `drain`/`routed`/`stale` trace, so a turn's records group in a flat sink. (`crates/microflow-core/src/runtime/mod.rs`)
2. **Microflow devtools** — an app-wide, TanStack-style bottom-drawer debug console (floating launcher bottom-right, raised above the TanStack devtools), streaming the **whole app's** activity through one unified `useDevLogStore`: backend `log::` records (hardware / MQTT / LLM — forwarded to the webview via `tauri-plugin-log`'s `log://log` webview target, `src-tauri/src/lib.rs`) **and** flow component-events. Rows: time · level · source · message, with filter + pause + clear. The two flow-ingest paths (browser `flow-reactor.ts`, desktop `use-component-events.ts`) were unified behind one shared `applyComponentEvent` (`apps/web/src/lib/event-ingest.ts`) so node values, edge animations, and the dev-log stay in lock-step on both platforms. New: `stores/dev-log.ts`, `hooks/use-backend-logs.ts` (parses the `[date][time][target][LEVEL] msg` format → source category), `components/devtools/microflow-devtools.tsx`, `stores/ui-panel.ts`, `lib/format-value.ts`; mounted at the app root (`routes/__root.tsx`) beside the TanStack devtools. Verified live in the running desktop app + web typecheck/oxlint clean.

Remaining:
- **Sink + tail sampling (Phase 4).** Ship the wide events to a queryable store; tail-sample the high-frequency `feed_bytes` ticks (keep errors/slow, sample the happy path).
- **Inspector v2 (optional polish).** Node status badges + per-edge value watches on the canvas; click-a-row-to-focus-the-node; virtualized list for very high event rates.

## This is not a typical web service — three distinct concerns

"Logging & tracing" here splits into three things that need different tools. Don't conflate them:

1. **Backend service observability** — the Hono/tRPC/collab/MQTT server. Classic *wide event per request* applies directly.
2. **Flow-runtime execution tracing** — tracing *data flowing through the node graph*. Domain-specific. The high-cardinality gold. Runs identically on desktop (Tauri) and browser (WASM).
3. **Product analytics** — what users actually do (run a flow, add a node). Umami is half-wired for this (pageviews only).

## Systemic moves (shared primitive, not per-instance patches)

### Rust — one facade, one choke-point
- **Swap `log` → `tracing`.** `tracing` ships a `log` compatibility layer, so the 198 existing call sites keep working while we gain spans + structured fields. One facade for desktop **and** WASM.
- **Subscriber that works in release + desktop + WASM:** `tracing-subscriber` with an `EnvFilter` (driven by `RUST_LOG`/a config var) for native; `tracing-wasm` (or a `console` layer) for the browser build. Remove the `debug_assertions`-only gate at `apps/web/src-tauri/src/lib.rs:133-139` so release builds aren't blind.
- **Instrument the single highest-leverage point — the flow drain loop** at `crates/microflow-core/src/runtime/mod.rs:560-577` (`finish()`). Every event passes here exactly once, all `Effects` assemble here, and it is identical on desktop + browser. Emit **one wide event per flow tick** with fields: `tick_id`, `events_drained`, `component_events`, `outbound_bytes`, `wakeups`, `cancellations`, `duration_us`, `error`. Add a per-event field set inside `process_event()` (`:582`) for node-level cardinality (`source_id`, `source_handle`, `sequence`, stale?).
- **Fix the silent swallow** in `runtime/cloud/mqtt.rs` (publish error logged then `Ok(())` ~`:154-157`) — propagate or count it. Guard the codegen `.unwrap()/.expect()` hotspots (`codegen/validate.rs`, `codegen/mod.rs`).

### TS backend — one logger, one canonical line, trace IDs
- **Adopt `pino`** (fast, structured, Bun-friendly). Replace ad-hoc `console.*`.
- **Request-context middleware (Hono):** generate/accept `request_id` + `trace_id`, stash on context, emit **one wide event per unit of work** — per tRPC call, per WS session, per MQTT message — with method/path/status/duration/user/error. Replaces Hono's stock `logger()` (`apps/server/src/index.ts:18`).
- **Fix silent `catch {}`** at `packages/collab/src/handler.ts:43-44,71-74` — log + count dropped WS sends.
- **drizzle logger** gated by a new `LOG_LEVEL` in `packages/env/src/server.ts` for slow-query visibility.

### Frontend — wrapper + error boundary + forward
- **One `logger` wrapper** gated by `import.meta.env.DEV` so 54 bare `console.*` calls stop shipping to prod.
- **React `ErrorBoundary`** at `apps/web/src/routes/__root.tsx` + global `window.onerror` / `unhandledrejection`.
- **Forward** client errors: desktop → existing Tauri log plugin; web → a lightweight backend ingest endpoint (or Sentry if we want a managed sink).
- **Umami custom events** for the analytics concern: `flow_run`, `node_added`, `board_connected` — turns load-and-forget pageviews into adoption signal.

### Crown jewel — one `trace_id` end-to-end
Generate a `trace_id` at the user action in the browser, then propagate it: JS → Tauri IPC (`flow_update`, `commands.rs:45`) → Rust runtime actor (`host.rs` `ActorMsg`) → `finish()` span → MQTT publish (user-property header) → backend wide event. This is the skill's "make your wide events *be* your trace spans," adapted to this app's real choke-points. One ID stitches frontend ↔ runtime ↔ cloud.

## Phased plan

- **Phase 0 — stop the bleeding (~1–2h):** fix the 3 silent swallows (`mqtt.rs`, collab `handler.ts` ×2); make Rust release logging work (drop the `debug_assertions` gate, add `EnvFilter`). Pure risk reduction, no new deps beyond `tracing-subscriber`.
- **Phase 1 — structured loggers:** `tracing` (Rust, via `log` compat) + `pino` (TS) + `LOG_LEVEL` in `packages/env`. Mechanical, high value.
- **Phase 2 — the two wide-event choke-points:** `finish()` flow-tick event (Rust) + per-request/WS/MQTT event (backend). This is where debugging becomes *querying*.
- **Phase 3 — `trace_id` propagation** across IPC + MQTT + backend (the crown jewel).
- **Phase 4 — sink + sampling:** ship events somewhere queryable (stdout→Loki/Axiom, or ClickHouse for the high-cardinality flow ticks). **Tail-sample** at emit: always keep errors + slow ticks; sample happy-path flow ticks hard, because a per-pin-change tick can fire at high frequency (the one real high-volume stream here).

## Notes on adapting the wide-events skill
- Backend volume is low → don't over-sample request events.
- **Flow ticks are the high-frequency stream** (hardware pin changes, timers) → those are the ones that need rate limiting / tail sampling, not the HTTP layer.
- Keep IDs non-negotiable everywhere: `trace_id`, `tick_id`/`request_id`. Without them the three surfaces can't be stitched.
