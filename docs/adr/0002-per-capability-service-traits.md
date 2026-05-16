# ADR-0002 — Per-capability service traits over a single `RuntimeContext` bundle

- **Status:** accepted
- **Date:** 2026-05-17
- **Deciders:** sander

## Context

External components — components in `runtime/external/` that talk to MQTT brokers,
LLM endpoints, etc. — currently reach their backing resources through two
inconsistent patterns:

1. **Snapshot-into-builder (LLM).** `flow_update` (`runtime/commands.rs:78`)
   constructs a `RuntimeContext { providers: Vec<ProviderEntry> }` from the
   frontend payload. `ComponentBuilder::build` is called with `&RuntimeContext`
   for every Catalog impl; only `Llm::build` actually consults it, to copy
   `base_url`/`api_key` into `LlmConfig`. The other ~31 builders take `_ctx`
   and ignore it. After construction, `Llm` owns its credentials and builds
   `reqwest::Client::new()` inline inside `Llm::spawn_generate`
   (`runtime/external/llm.rs:99-183`). There is no abstraction over the wire.

2. **Event-out, manager-resolves (MQTT/Figma).** `Mqtt`/`Figma` know only a
   `broker_id`. They emit a reserved `_mqtt_publish` event whose value carries
   `{brokerId, topic, payload, retain}`. The event leaves the runtime via the
   event channel, is intercepted in `lib.rs::run`'s event-forwarding thread
   (`apps/web/src-tauri/src/lib.rs:167-196`), and re-dispatched onto an
   `MqttPublishRequest` channel that another thread drains by calling
   `state.mqtt_manager.publish(...)`. The component is decoupled from the
   manager — at the cost of a stringly-typed event protocol and an extra
   thread hop.

This split has accreted three concrete pains:

- **Dead writer / dual state.** `LlmManager` (`apps/web/src-tauri/src/llm/manager.rs`)
  exists as `Arc<RwLock<HashMap<id, ProviderConfig>>>`, synced from the
  frontend via the `llm_sync_providers` Tauri command. **Nothing reads
  `LlmManager.get()`.** The same provider data is *also* pushed through
  `flow_update` into `RuntimeContext.providers`. Two sync paths, two stores,
  zero readers of the manager. Engineer reading the code cannot tell which
  is canonical.

- **Stale-credential hazard via `pending_flow`.** `AppState.pending_flow:
  Arc<RwLock<Option<(FlowUpdate, RuntimeContext)>>>` (`lib.rs:78`). When the
  board is disconnected at `flow_update` time, the `RuntimeContext` is stored
  alongside the flow and replayed on board-connect (`lib.rs:262-264`). If a
  provider's API key rotates between the two events, the `Llm` component is
  built with stale credentials. `LlmConfig` then snapshots those credentials,
  so the staleness sticks until the next `flow_update`.

- **No test seam for LLM/MQTT.** `BoardHandle` has `TestIoLoop` as a paired
  adapter at the `BoardCommand` channel (CONTEXT.md § TestIoLoop) — one
  production adapter, one test adapter, which is what makes the seam real
  (per the `LANGUAGE.md` rule of thumb). LLM and MQTT have no such pair.
  Testing `Llm` today requires running a real OpenAI-compatible endpoint or
  monkey-patching reqwest. Testing `Mqtt`/`Figma` requires standing up a
  broker or stubbing the event interceptor in `lib.rs`. The trait does not
  exist; there is nothing to substitute.

The system will gain more external kinds (HTTP webhook, OSC, WebSocket, more
LLM providers). Each new kind under the current split forces another choice
between "snapshot into config" and "emit reserved event," another bespoke
manager, and another untested code path.

## Decision

Introduce a layered service-trait architecture, replacing both patterns with
one.

```
┌─ Layer 1: Capability traits (one per external kind) ──────┐
│  trait LlmProvider:   async fn generate(req) -> resp      │
│  trait MqttPublisher: async fn publish(topic, payload)    │
│  trait HttpCaller:    ... (added when needed)             │
└────────────────────────────────────────────────────────────┘
┌─ Layer 2: Service registries (one per kind) ──────────────┐
│  LlmRegistry   { RwLock<HashMap<id, Arc<dyn LlmProvider>>> }
│  MqttRegistry  { RwLock<HashMap<id, Arc<dyn MqttPublisher>>> }
│  Sync command refreshes entries; live components observe   │
│  updates without rebuild.                                  │
└────────────────────────────────────────────────────────────┘
┌─ Layer 3: RuntimeServices (replaces RuntimeContext) ──────┐
│  pub struct RuntimeServices {                              │
│      llm:  Arc<LlmRegistry>,                               │
│      mqtt: Arc<MqttRegistry>,                              │
│      ...                                                   │
│  }                                                         │
└────────────────────────────────────────────────────────────┘
┌─ Layer 4: ComponentBuilder declares typed Deps ───────────┐
│  trait ComponentBuilder {                                  │
│      type Deps = ();              // default: needs none   │
│      fn build(id, config, deps: Self::Deps) -> Result      │
│  }                                                         │
│  impl ComponentBuilder for Llm  { type Deps = Arc<LlmRegistry>;  }
│  impl ComponentBuilder for Mqtt { type Deps = Arc<MqttRegistry>; }
│  Registry factory projects Deps from RuntimeServices per impl
└────────────────────────────────────────────────────────────┘
┌─ Layer 5: Dispatch-time lookup, not build-time snapshot ──┐
│  Llm.dispatch("trigger") → llm_registry.get(&provider_id) │
│      ?.generate(req).await                                 │
│  No more stale ctx in pending_flow. Key rotation takes      │
│  effect on the next call.                                  │
└────────────────────────────────────────────────────────────┘
```

Five sub-decisions:

- **D1 — Per-capability traits, not a single `ExternalGateway` trait.** Each
  external kind gets its own trait surface. Adding HTTP/OSC/WebSocket adds a
  new trait + registry; it does not grow an existing god-trait. Cost: one
  trait per kind. Benefit: Open/Closed at the trait boundary.

- **D2 — Live `Arc<dyn Trait>` registries, not value snapshots.** Components
  hold `Arc<Registry>` and look up the provider per call. Credential rotation
  works without rebuilding components. The dead `LlmManager` becomes the
  production `LlmRegistry`, finally read.

- **D3 — Trait dispatch over event-emission for outbound calls.** `Mqtt`
  publishes via `Arc<dyn MqttPublisher>` instead of emitting `_mqtt_publish`
  events that `lib.rs` re-routes. The event interceptor retires once unused;
  the runtime stops being a thread-hop router for external calls.

- **D4 — Typed `ComponentBuilder::Deps`, not a universal `&RuntimeContext`.**
  Each `ComponentBuilder` impl declares exactly the registries it needs.
  Default `type Deps = ()` for the ~30 components that need nothing. The
  registry factory projects the right `Deps` from `RuntimeServices` per impl.
  `RuntimeContext` and `ProviderEntry` delete.

- **D5 — Two adapters per trait from day one.** Production HTTP/MQTT impls,
  plus a test impl (`RecordingLlmProvider`, `RecordingMqttPublisher`) that
  records inbound calls and returns scripted outcomes. Mirrors the
  `BoardHandle` + `TestIoLoop` pattern. The second adapter is what makes
  each trait a *real* seam (per `LANGUAGE.md`).

Roll out in four phases. Each compiles and ships:

1. **Phase 1** — Add `runtime/services` module with the LLM capability trait,
   registry, production HTTP impl, and recording test impl. Pure addition —
   existing `Llm` component is untouched, existing `LlmManager` remains in
   place. Lands the foundation and the test pair.
2. **Phase 2** — Migrate `Llm` component to hold `Arc<LlmRegistry>` and
   resolve the provider at dispatch time. Drop snapshot fields from
   `LlmConfig`. Retire `LlmManager` in favour of `LlmRegistry`.
3. **Phase 3** — Same shape for MQTT: `MqttPublisher` trait, `MqttRegistry`,
   migrate `Mqtt`/`Figma`. Retire the `_mqtt_publish` event interceptor.
4. **Phase 4** — Introduce `RuntimeServices` + `ComponentBuilder::Deps`.
   Delete `RuntimeContext`, `ProviderEntry`. Update 31 pass-through builders
   to drop `_ctx`. Change `AppState.pending_flow` to hold
   `Arc<RuntimeServices>`.

## Consequences

**Positive**

- One pattern for external service access. Adding a new kind (HTTP, OSC,
  WebSocket) is template work: define trait, define registry, add field to
  `RuntimeServices`. No bespoke per-kind plumbing in `lib.rs`.
- Tests for `Llm`/`Mqtt`/`Figma` become unit tests against a recording
  adapter. Component logic verifiable without standing up a broker, an LLM
  endpoint, or the Tauri host.
- Provider/broker credential rotation takes effect on the next dispatch —
  no component rebuild, no flow_update re-fire.
- `RuntimeContext` deletes; 31 pass-through `_ctx` params delete.
  `ComponentBuilder` signature shrinks.
- `LlmManager` stops being dead code (becomes `LlmRegistry`).
- The `_mqtt_publish` event interceptor in `lib.rs::run` deletes;
  `mqtt_publish_tx`/`MqttPublishRequest`/the dedicated publish thread go with
  it.

**Negative**

- `ComponentBuilder` grows an associated `type Deps` with a default. The
  registry factory closure (`runtime/registry.rs::Factory`) becomes generic
  over `<B>` and projects `Deps` per impl. Slightly more type plumbing in the
  registry; offset by deleting `RuntimeContext` and 31 `_ctx` params.
- Async traits require the `async-trait` crate (or native async-in-trait
  with `Pin<Box<Future>>` boilerplate). New dep: `async-trait = "0.1"`.
- Two registries (`LlmRegistry`, `MqttRegistry`) become the long-lived
  shared state, instead of one `RuntimeContext` value. Lifetime is the
  app lifetime; held via `Arc` in `AppState` and forwarded to components.
- The `Mqtt` event-emission path was used by `Figma` too. Migrating Figma
  in Phase 3 requires its `dispatch` arms to call `MqttPublisher::publish`
  directly instead of emitting `_mqtt_publish`. The event handle disappears
  from the `executor`'s `_`-prefix routing.

**Neutral**

- `ListenerWiring` / `SubscriberWiring` (CONTEXT.md § Wiring) are
  unaffected. Wiring is descriptive data returned from components; this ADR
  changes how *outbound* external calls are dispatched, not how inbound
  subscriptions are described.
- `BoardHandle` is unaffected. Hardware seams already follow the
  one-trait-one-test-adapter pattern; this ADR generalises that pattern to
  the other external kinds.

## Glossary

New terms recorded in `CONTEXT.md`:

- **Capability Trait** — a trait describing one external kind's operations
  (e.g. `LlmProvider`, `MqttPublisher`).
- **Service Registry** — a live `Arc<RwLock<HashMap<id, Arc<dyn Trait>>>>`
  of capability-trait implementations keyed by an id from the frontend.
- **Runtime Services** — the typed bundle of registries passed to
  `ComponentBuilder::build` via the impl's associated `Deps`.
- **LLM Provider** — a `Capability Trait` for any backend that can run an
  LLM completion against an OpenAI-compatible request shape.

## References

- `apps/web/src-tauri/src/runtime/context.rs` — `RuntimeContext` and
  `ProviderEntry` (to delete in Phase 4).
- `apps/web/src-tauri/src/runtime/builders.rs` — 32 `ComponentBuilder` impls
  (31 with `_ctx`, 1 reading `ctx`).
- `apps/web/src-tauri/src/runtime/external/llm.rs` — inline `reqwest::Client`
  HTTP call (to retire in Phase 2).
- `apps/web/src-tauri/src/runtime/external/mqtt.rs`,
  `apps/web/src-tauri/src/runtime/external/figma.rs` — `_mqtt_publish` emit
  sites (to retire in Phase 3).
- `apps/web/src-tauri/src/lib.rs:167-196` — `_mqtt_publish` event
  interceptor (to retire in Phase 3).
- `apps/web/src-tauri/src/llm/manager.rs` — `LlmManager` dead writer
  (folds into `LlmRegistry` in Phase 2).
- `apps/web/src-tauri/src/mqtt/manager.rs` — `MqttManager` (becomes the
  production `MqttPublisher` impl in Phase 3).
- `CONTEXT.md` § Runtime Context (to delete in Phase 4) and § BoardHandle /
  § TestIoLoop (the seam pattern this ADR generalises).
- `ADR-0001` — Component trait flow separation (sets the precedent for
  splitting an overloaded interface into typed seams).
