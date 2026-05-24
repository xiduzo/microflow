# ADR-0005 — `FlowUpdateDispatcher` class with injected `Sender`, `Scheduler`, and `NodeAdapterRegistry`

- **Status:** accepted
- **Date:** 2026-05-23
- **Deciders:** sander

## Context

[ADR-0003](0003-flow-session-seam.md) extracted the editing + sync layer
into `FlowSession` and reserved the name `FlowUpdateDispatcher` for the
desktop-only observer that pushes `FlowUpdate` payloads to the native
runtime. The actual dispatcher remained a placeholder hook
(`apps/web/src/session/use-flow-update-dispatcher.ts`) wrapping the
legacy `flow-store.setupDocSync` logic verbatim — observer + debounced
async callback + direct calls into `useMqttBrokerStore.getState()`,
`useFigmaStore.getState()`, dynamic `import("@/stores/llm-provider")`,
and `invokeCommand("flow_update", ...)`.

That placeholder had three concrete problems:

- **Untestable.** Verifying "remote collaborator update also dispatches
  to runtime" or "credential rotation takes effect on the next call"
  required mounting React, mocking Tauri, mocking zustand stores, and
  awaiting a 500ms debounce. The thing being tested — a payload built
  from doc state + host snapshot, sent through a transport — is
  ordinary logic that should be vitest-able.
- **Tightly coupled to module-load env.** The hook imported the
  codegen'd `NODE_REGISTRY` directly. `NODE_REGISTRY` imports every
  node component, several of which transitively import
  `@/lib/auth-client` → `@microflow/env/web` → fails at module load
  when `VITE_SERVER_URL` isn't set. Tests for the dispatcher couldn't
  load the file without the whole web env in scope.
- **Two responsibilities tangled.** The hook simultaneously: (a)
  decided when to dispatch (debounce), (b) gathered host state from
  three sibling stores, (c) walked the node registry to apply host
  adapter patches, (d) built the wire payload, (e) called the IPC
  transport. No name for any of (a)–(e); changing the debounce
  strategy required reading the gathering logic; changing the
  transport required reading the debounce logic.

ADR-0003 D6 promised: *"a follow-up ADR will deepen the dispatcher,
name its internal `FlowUpdate` builder, and decide where
broker/provider gathering belongs."* This ADR delivers that.

## Decision

Replace the placeholder hook with a `FlowUpdateDispatcher` class that
takes five injected dependencies, plus a set of pure helpers that
compose into a `buildFlowUpdate` function.

```text
┌─ Pure helpers (composable, testable) ─────────────────────┐
│  applyHostAdapterPatches(nodes, hostState, registry)       │
│      → { nodes, brokerIds }                                │
│  gatherBrokers(brokerIds, allBrokers) → DispatchedBroker[] │
│  gatherProviders(allProviders) → DispatchedProvider[]      │
│  buildFlowUpdate(doc, snapshot, registry) → FlowUpdate     │
└────────────────────────────────────────────────────────────┘
┌─ FlowUpdateSender (transport seam) ───────────────────────┐
│  interface FlowUpdateSender { send(update) → Promise }     │
│  class TauriFlowUpdateSender (production, wraps IPC)       │
│  class RecordingFlowUpdateSender (test, captures + scripts)│
└────────────────────────────────────────────────────────────┘
┌─ DispatchScheduler (debounce seam) ───────────────────────┐
│  interface DispatchScheduler { schedule, cancel }          │
│  class DebounceScheduler (production, react-pacer 500ms)   │
│  class ManualDispatchScheduler (test, .flush() helper)     │
└────────────────────────────────────────────────────────────┘
┌─ FlowUpdateDispatcher class ──────────────────────────────┐
│  constructor(session, snapshotProvider, sender,            │
│              scheduler, registry)                          │
│      - subscribes to session.doc.onAnyChange               │
│      - fires one immediate dispatch on construction        │
│  private requestDispatch() → scheduler.schedule(...)       │
│  async dispatchNow() → buildFlowUpdate + sender.send       │
│  destroy() → unobserve + scheduler.cancel; idempotent      │
└────────────────────────────────────────────────────────────┘
┌─ React adapter (thin) ────────────────────────────────────┐
│  useFlowUpdateDispatcher(session) — useState lazy init +   │
│  useEffect cleanup; wires production sender + scheduler +  │
│  NODE_REGISTRY; isDesktop-gated at the route, not here.    │
└────────────────────────────────────────────────────────────┘
```

Six sub-decisions:

- **D1 — Class with injected dependencies, not closures over module
  imports.** Matches the
  [`ReactFlowBridge`](0004-react-flow-bridge.md) pattern and the
  per-capability service-trait discipline from
  [ADR-0002](0002-per-capability-service-traits.md). Lifecycle
  (observer + scheduler + sender) lives on the class with `destroy()`
  as the single cleanup entry point. Hook owns wiring + React-tied
  side effects; class owns the dispatch logic.

- **D2 — `FlowUpdateSender` interface, with production + recording
  adapters from day one.** `TauriFlowUpdateSender` wraps the IPC
  call; `RecordingFlowUpdateSender` captures every dispatched
  `FlowUpdate` and accepts scripted errors via `scriptError(msg)`.
  Mirrors `RemoteSyncAdapter` / `RecordingSyncAdapter` from
  [ADR-0002](0002-per-capability-service-traits.md). Production and
  test paths are split across two files (`flow-update-sender.ts`,
  `tauri-flow-update-sender.ts`) so the test bundle doesn't import
  Tauri / `@microflow/env`.

- **D3 — `DispatchScheduler` interface for the debounce strategy.**
  `DebounceScheduler` wraps `@tanstack/react-pacer` for production
  (500ms). `ManualDispatchScheduler` exposes a `.flush()` method for
  tests so they can drive dispatch timing deterministically without
  awaiting paint or timer frames. The dispatcher itself knows nothing
  about debounce — it just calls `scheduler.schedule(cb)`.

- **D4 — `HostSnapshotProvider: () => HostSnapshot` re-read on every
  dispatch, not snapshotted at construction.** Live MQTT broker
  configs and LLM provider credentials change while the dispatcher
  lives (user adds a broker, rotates an API key). The provider
  function returns the current `HostSnapshot` at each dispatch — same
  pattern as the Rust side's [`LlmRegistry`](../../apps/web/src-tauri/src/runtime/services/llm.rs)
  "live `Arc<dyn Trait>`, not value snapshot" decision in
  [ADR-0002 D2](0002-per-capability-service-traits.md). The hook
  reads from `useMqttBrokerStore.getState()` /
  `useLlmProviderStore.getState()` / `useFigmaStore.getState()`
  inside the provider closure.

- **D5 — `NodeAdapterRegistry` injected, not imported from codegen.**
  The dispatcher's `buildFlowUpdate` walks per-node `NodeHostAdapter`s
  to apply `prepareData` patches and collect broker IDs. Directly
  importing `NODE_REGISTRY` would pull every generated node component
  module into the dispatcher's import graph — including ones that
  transitively touch `@microflow/env/web` and crash in test
  environments without `VITE_SERVER_URL`. The dispatcher accepts a
  minimal `Record<instance, { adapter? }>` shape and the production
  hook passes `NODE_REGISTRY`; tests pass `{}` or hand-built stubs
  that exercise specific adapter behaviour. This decouples the
  dispatcher module from the generated registry.

- **D6 — Pure helpers as named exports, dispatcher composes them.**
  `applyHostAdapterPatches`, `gatherBrokers`, `gatherProviders`,
  `buildFlowUpdate` are all pure functions in
  `flow-update-dispatcher.ts`, individually testable. Reading the
  dispatcher's `dispatchNow()` is a four-line composition; reading
  the helpers tells you *what* each step does. The current
  implementation had all four jobs inlined in one debounced
  async callback.

## Consequences

**Positive**

- **17 vitest cases**, all green, exercising every leg: pure helpers
  (`gatherBrokers`, `gatherProviders`, `buildFlowUpdate`, three
  `applyHostAdapterPatches` cases), dispatcher integration (initial
  dispatch, mutation-triggered, coalescing across mutations, credential
  rotation, scripted error, destroy + idempotent destroy,
  dispatchNow-after-destroy returns error, remote-origin parity).
  None require React, Tauri, or the env module to load.
- **Production parity.** `useFlowUpdateDispatcher` is a 35-LOC hook
  that constructs the dispatcher with production sender +
  scheduler + `NODE_REGISTRY`. The route still gates on `isDesktop`.
  Existing call sites unchanged.
- **Sender + Scheduler are real seams.** Two adapters each
  (production + recording / debounce + manual) from day one — per the
  "one adapter = hypothetical, two = real" rule in
  [`LANGUAGE.md`](../../.claude/skills/improve-codebase-architecture/LANGUAGE.md).
  Adding a `BatchingScheduler` (e.g. coalesce by structural-change
  count) or a `ReplayingFlowUpdateSender` (e.g. log to disk for
  post-mortem) is template work.
- **Credential rotation now testable.** Test
  `"snapshot provider re-read on every dispatch"` proves it: vary the
  closed-over API key between dispatches, assert each payload carries
  the latest. The Rust-side `LlmRegistry`
  ([ADR-0002 D2](0002-per-capability-service-traits.md)) is now
  paired with a host-side dispatcher that also doesn't snapshot.
- **Deletion test passes.** Removing `flow-update-dispatcher.ts` +
  `flow-update-sender.ts` + `tauri-flow-update-sender.ts` re-inlines
  five named operations into one anonymous debounced async callback
  with three direct store reads, a dynamic import, and a stringly-typed
  IPC call. ~130 LOC of structure reappears with no name.

**Negative**

- **Constructor takes five arguments.** Long parameter list, but each
  arg names a distinct seam. An options-bag form (`new Dispatcher({...})`)
  was considered and rejected — positional args make the dependency
  set visible at every construction site, and there are only two
  (production hook, tests).
- **`DebounceScheduler.cancel()` is a no-op.** `@tanstack/react-pacer`
  Debouncer doesn't expose an external cancel hook. The dispatcher's
  `destroyed` flag in `dispatchNow` is the fail-safe: if the debouncer
  fires after `destroy()`, the dispatch is a no-op. Worth a follow-up
  to upstream `react-pacer` or wrap in a cancellable scheduler.
- **`NodeAdapterRegistry` type is wider than what the production
  `NODE_REGISTRY` is.** Production registry has many other fields
  (`Component`, `defaults`, etc); the dispatcher only needs `adapter`.
  The narrower type accepts the wider production value via TypeScript
  structural typing, but it does mean the test-stub type is less
  strict than the production type. Acceptable; the dispatcher really
  doesn't need the other fields.

**Neutral**

- **Hook signature unchanged.** `useFlowUpdateDispatcher(session)` is
  still the call from
  [`routes/flow/$flowId.tsx`](../../apps/web/src/routes/flow/$flowId.tsx).
  The hook's internals were rewritten; no migration at call sites.
- **`TauriFlowUpdateSender` is a thin pass-through today.** If the
  IPC payload shape changes, the sender absorbs it without touching
  the dispatcher. The split file is also where a `BatchingSender` or
  retry logic would land if needed.

## Glossary

New terms recorded in [`CONTEXT.md`](../../CONTEXT.md) (`FlowUpdateDispatcher`
section rewritten):

- **FlowUpdateDispatcher** — Desktop-only class that observes a
  `FlowSession`'s `FlowDocument` and ships `FlowUpdate` payloads to the
  native runtime through an injected `FlowUpdateSender`, scheduled by
  an injected `DispatchScheduler`.
- **FlowUpdateSender** — Transport interface. Implemented by
  `TauriFlowUpdateSender` (production) and `RecordingFlowUpdateSender`
  (tests).
- **DispatchScheduler** — Debounce-strategy interface. Implemented by
  `DebounceScheduler` (production, 500ms via `@tanstack/react-pacer`)
  and `ManualDispatchScheduler` (tests, with `.flush()`).
- **HostSnapshot / HostSnapshotProvider** — Live read of MQTT brokers,
  LLM providers, and Figma uniqueId. Provider function re-invoked on
  every dispatch so credential rotation takes effect on the next call.
- **NodeAdapterRegistry** — Minimal `Record<instance, { adapter? }>`
  shape the dispatcher needs from the codegen'd `NODE_REGISTRY`.
  Injected to decouple the dispatcher module from the generated
  registry's transitive imports.
- **applyHostAdapterPatches / gatherBrokers / gatherProviders /
  buildFlowUpdate** — Pure composable helpers. Each independently
  testable.

## References

- `apps/web/src/session/flow-update-dispatcher.ts` — class + pure
  helpers + `ManualDispatchScheduler`.
- `apps/web/src/session/flow-update-sender.ts` — interface + types +
  `RecordingFlowUpdateSender`.
- `apps/web/src/session/tauri-flow-update-sender.ts` — production
  sender (split file so tests don't pull Tauri / env).
- `apps/web/src/session/use-flow-update-dispatcher.ts` — production
  React adapter wiring.
- `apps/web/src/session/__tests__/flow-update-dispatcher.test.ts` —
  17 cases.
- [ADR-0002](0002-per-capability-service-traits.md) — sender / scheduler
  patterns mirror the Rust-side capability-trait + recording-test
  discipline; `HostSnapshotProvider` mirrors the live-registry
  decision in D2.
- [ADR-0003 D6](0003-flow-session-seam.md) — committed this follow-up
  ADR.
- [ADR-0004](0004-react-flow-bridge.md) — same class+thin-hook +
  `useState` lazy init + `useEffect` cleanup pattern.
- `CONTEXT.md` § FlowUpdateDispatcher (rewritten).
