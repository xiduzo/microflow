# ADR-0009 — Cloud as a sans-IO capability: cloud I/O becomes an `Effect`, performed per-host

- **Status:** accepted — **complete** (2026-06-22): Phases 1–3 implemented (cloud
  nodes run in both hosts — LLM + MQTT + Figma in the browser). **Phase 4 (CORS
  proxy) declined** — direct-only; see the Phase 4 note below.
- **Date:** 2026-06-21
- **Deciders:** sander

> **Phases 1–2 implemented (desktop cloud is now sans-IO).** Core: `CloudRequest`
> + `CloudRequestKind` + `Effects.cloud_requests` + `RuntimeContext::request_cloud`
> + `EffectsSink::perform_cloud` (driven by `Effects::apply` in canonical order
> `bytes → cancel → arm → cloud → event`); `FlowRuntime::register_cloud::<B>` /
> `ComponentRegistry::register_cloud`. Desktop: the `Mqtt`/`Llm`/`Figma` nodes
> emit `CloudRequest`s (no Tokio/`reqwest`/`rumqttc`); the relocated I/O lives in a
> new `CloudPerformer` deep module on the actor (MQTT/Figma publish via
> `rumqttc`, LLM via `reqwest` with latest-wins cancellation), results re-entering
> as `ActorMsg::Inject`. `register_cloud_nodes` collapsed to three `register_cloud`
> lines; `CloudEmitter`/`ChannelEmitter`/`RecordingCloudEmitter` deleted; cloud
> node tests are now synchronous request assertions and the I/O regression net
> moved to `CloudPerformer` tests. Verified: core 365, desktop 58 + catalog_parity
> + clippy clean, browser conformance + `tsc` clean. **D4 signed off** (below):
> user-entered/keyless, direct-by-default, proxy is CORS-only.
>
> **Phase 3 — cloud relocated to core + LLM runs in the browser (2026-06-22).**
> The sans-IO cloud nodes + their POD configs moved out of the desktop crate into
> `microflow-core` (`runtime/cloud/{mqtt,llm,figma}.rs` behind the `cloud` feature;
> `config/{mqtt,llm,figma}.rs` ungated). They register in `ComponentRegistry::
> register_all` like any built-in, so **both** hosts get them from one place — the
> host-injected `register_factory`/`register_node`/`register_cloud` machinery is
> deleted, and the Catalog Parity Guard reads cloud from `declared()` uniformly.
> The wasm crate enables `cloud` and exposes `injectEvent`; `FlowReactor.
> performCloud` performs `llmGenerate` directly (browser `fetch` to an
> OpenAI-compatible endpoint, mirroring the desktop `HttpLlmProvider`, with
> latest-wins `AbortController` cancellation), resolving the provider from the
> `llm-provider` store and re-entering `thinking`/`value`/`done`/`error` via
> `injectEvent`. Verified green: core 376, desktop 47 + catalog_parity + clippy,
> wasm crate 4, web 144 (+ `llm-client` transport tests) + `tsc`.
>
> **MQTT + Figma in the browser landed (2026-06-22).** Added `mqtt@5` and a
> per-broker MQTT-over-WSS connection manager (`lib/firmata/cloud/mqtt-client.ts`,
> the browser analog of the desktop `MqttManager`). `FlowReactor.performCloud`
> now publishes `mqttPublish` (Mqtt node + Figma set-value); on each `applyFlow`
> it reconciles the runtime's `subscriberWirings()` into WSS subscriptions (a
> pure mirror of the desktop `flow_update` dedup/diff in
> `cloud/mqtt-subscriptions.ts`), routes `plain`/`topicAware` inbound via the new
> `deliverMessage` binding, runs the Figma uid connect/disconnect handshake, and
> feeds display topics to the Figma store (the browser counterpart of the desktop
> "mqtt-message" event, via a new platform-agnostic `useFigmaStore.ingestMqttMessage`).
> Brokers resolve from `mqtt-broker` store; `url` must be a `ws://`/`wss://`
> endpoint (browsers can't open raw MQTT sockets). Verified: web 151 (+ reconcile
> tests) + `tsc` + **vite production build** (mqtt bundles, no polyfills), wasm
> crate 6.
>
> **Phase 4 (CORS proxy) — declined (2026-06-22, sander).** Browser cloud is
> **direct-only**; there is no server-side relay. A user who picks a CORS-strict
> LLM provider or a TCP-only broker is expected to make their *own* endpoint reach
> microflow — add microflow's origin to the provider's CORS allowlist, or expose a
> browser-reachable `wss://` broker. Rationale: keeps microflow's backend entirely
> out of the cloud data path (no third-party traffic or user keys ever transit our
> server), which is the natural endpoint of D4 (user-entered keys, direct calls).
> The cost is borne by the few strict endpoints, by their owner, once — not by our
> server forever. Reopen only if a must-support provider emerges that *cannot* be
> configured to allow a browser origin.

## Context

ADR-0006 re-hosted the engine on `microflow-core` and made it sans-IO: a node
never touches IO; it records [`Effects`] the host applies. The cloud nodes
(`Mqtt`, `Llm`, `Figma`) are the **one exception** — and the exception now blocks
the browser.

How cloud works today:

- The cloud nodes live in the desktop crate (`apps/web/src-tauri/src/runtime/cloud/`)
  and hold both a capability handle **and a Tokio runtime handle** —
  `Mqtt { publisher: Arc<dyn MqttPublisher>, rt_handle: Option<tokio::runtime::Handle> }`
  (`cloud/mqtt.rs:52`), `Llm { llm_registry, rt_handle, emitter: Option<Arc<dyn CloudEmitter>> }`
  (`cloud/llm.rs:85`). Their `dispatch` **spawns an async task** on the injected
  handle; the result re-enters via `CloudEmitter::emit` →
  `ActorMsg::Inject` (`host.rs:94-115`) → `FlowRuntime::inject_event`.
- They are registered out-of-band through the `register_factory` escape hatch in
  `host.rs::register_cloud_nodes` (`host.rs:117-196`) — hand-written closures that
  re-do config deserialization and capture the live services. This keeps
  `tokio`/`reqwest`/`rumqttc` out of core (the deliberate re-host trade).
- The wasm runtime (`crates/microflow-runtime-wasm/src/lib.rs:58-132`) exposes
  `new/setPins/updateFlow/feedBytes/wake/dispatch` and **no `inject_event`**, has
  no Tokio, and registers only the core (non-cloud) nodes. A browser flow
  containing a cloud node deserializes fine, then fails at instantiation
  (`ComponentNotFound`) — silently. **The catalog advertises cloud nodes on a
  host that cannot build them.**

Two problems compound: (a) the cloud node **initiates IO** (a sans-IO violation
that only works because desktop has Tokio), and (b) "one engine, two hosts" is
false for cloud.

**Product decision (with sander):** cloud nodes *should* run in the browser.
There is no platform blocker — an LLM call is a `fetch`, MQTT and Figma are
protocols the browser speaks over WebSocket (WSS). The gap is architectural.

## Decision

Bring cloud onto the sans-IO model: **cloud I/O becomes an `Effect`**, performed
by each host's `EffectsSink` (ADR-0008), with results re-entering through the
existing `inject_event`.

- **D1 — Cloud requests are an `Effect`, not an in-component spawn.** A cloud
  node's `dispatch` records a `CloudRequest { correlation_id, kind, provider_id,
  payload, .. }` into `Effects.cloud_requests` instead of spawning. The node holds
  **no Tokio handle and no live service** — it is now fully sans-IO and unit-
  testable by asserting the emitted request, exactly like every other node is
  tested against `Effects.outbound_bytes`.

- **D2 — The host performs the request and re-enters via `inject_event`.** The
  result (or stream item) is fed back through the existing `inject_event` path —
  the `CloudEmitter` shape is reused for *results*, not requests.
  - **Desktop sink** (`EffectsSink::perform_cloud`): the *existing* `reqwest`
    (LLM) / `rumqttc` (MQTT) / Figma-WSS code, **relocated** from inside the
    components to the host sink. Same libraries, same behaviour; the in-component
    spawn and the bespoke `register_cloud_nodes` closures are deleted.
  - **Browser sink**: `fetch` (LLM) and MQTT/Figma over WSS, performed in the
    reactor; results re-enter through a new wasm `injectEvent` / `resolveCloud`
    binding.

- **D3 — Inbound subscriptions stay descriptive and are honored per host.**
  Long-lived subscriptions (MQTT subscribe, Figma streams) already return
  `SubscriberWiring` data (`Component::subscriber_wiring`) and deliver via
  `FlowRuntime::deliver_message` + `Component::receive_raw_message`. No new model:
  each host sets up the subscription its own way (desktop broker pool; browser
  WSS) and feeds messages back through `deliver_message`. The descriptive-wiring
  pattern (CONTEXT.md § Wiring) already fits.

- **D4 — Credentials are a per-host adapter choice, not an architecture fork.**
  Same capability seam, two adapter strategies, selected per provider config:
  - **Direct** (default): the user's own key, in the user's own browser, calls the
    provider/broker directly (`fetch`/WSS). Correct for keyless/local endpoints
    (Ollama, public brokers) and for user-entered keys. The real constraint is
    **CORS**, not secrecy.
  - **Proxy** (fallback): route through the existing `apps/server` tRPC backend
    (`appRouter` gains `cloud.llm` / `cloud.publish` procedures) so the key never
    leaves the server and CORS-blocked providers work. **(Declined — Phase 4 note:
    browser cloud stays direct-only; the proxy adapter is not built.)**

  ✅ **Sign-off (sander, 2026-06-21):** **user-entered / keyless** — every key is
  typed by the user into their own browser, or the endpoint is keyless/local
  (Ollama, public brokers). The browser sink calls providers **directly**
  (`fetch`/WSS) by default; the **proxy is a CORS-only fallback**, not a secret
  vault. There are **no** server-managed or shared keys, so no provider is
  proxy-only and the sink needs no per-provider "proxy-only" enforcement. (Should
  a server-held key ever be introduced, that provider must become proxy-only — out
  of scope here.)

- **D5 — Cloud registration becomes uniform.** With cloud nodes sans-IO, the
  per-node deserialize boilerplate in the closures disappears: a small
  `register_cloud::<B>(name)` helper reuses `make_factory`'s config path (the node
  needs no build-time service injection — it emits requests). The catalog marks
  cloud nodes (`impls[].host: "cloud"`, or reuse the existing `external` category)
  so the **Catalog Parity Guard** (ADR-0007) and the editor know they are
  host-performed, and **both** hosts register them.

### Rollout (each phase compiles; desktop stays green throughout)

1. **Core.** Add `CloudRequest` + `Effects.cloud_requests`; add
   `EffectsSink::perform_cloud` (extends ADR-0008's sink); expose
   `injectEvent`/`resolveCloud` on `microflow-runtime-wasm`. Move the cloud
   config structs (serde-POD) into `microflow-core/src/config`; rewrite the cloud
   components to emit `CloudRequest`s; register via `register_cloud`.
2. **Desktop sink.** Implement `perform_cloud` with the existing reqwest/rumqttc/
   Figma code relocated from the components. Regression net = the existing
   `RecordingLlmProvider` / `RecordingMqttPublisher` tests. Delete the
   in-component spawn and the `register_cloud_nodes` closures.
3. **Browser sink.** Implement `perform_cloud` (fetch / WSS) in the reactor; wire
   `resolveCloud`; honor `subscriber_wiring` for inbound. Cloud nodes run in the
   browser.
4. ~~**Proxy + policy.** Add `cloud.*` tRPC procedures; the browser sink selects
   direct-vs-proxy per provider (D4).~~ **Declined** (see the Phase 4 note above):
   browser cloud is direct-only; CORS-strict endpoints are the user's to allowlist.
   The editor already does not mark cloud nodes browser-unavailable (Phase 3).

## Consequences

**Positive**

- Cloud components become unit-testable without Tokio *or* a host — assert the
  `CloudRequest` in `Effects` — the property ADR-0006 gave the rest of the engine.
- "One engine, two hosts" becomes true for cloud; browser gains MQTT/LLM/Figma.
- The last sans-IO violation (in-component spawn) is removed; the `register_factory`
  closure special-case collapses into a typed `register_cloud`.
- Deletion test: removing `perform_cloud` re-spreads platform IO back into the
  components in both hosts.

**Negative / debt**

- Phase 2 reworks **working, tested desktop cloud code**. Mitigated by relocating
  (not rewriting) the reqwest/rumqttc bodies and leaning on the recording-adapter
  tests as the regression net.
- **CORS** is the real practical blocker for browser-direct (Phase 3); the proxy
  adapter (Phase 4) is the escape hatch — sequence P4 immediately after P3 if the
  target providers are CORS-strict.
- **Figma** is the least-specified node here (exact REST-vs-WSS transport);
  confirm with a short spike before Phase 3.
- An async result that arrives after its node/flow was removed must be dropped
  safely (correlation-id no longer live) — both sinks must guard this, as the
  desktop actor's `inject_event` already tolerates stale sources.

**Supersedes**

- The cloud half of the `register_factory` closure model and the in-component
  Tokio spawn (ADR-0002's "trait dispatch over event-emission" still holds for
  *what* the capability is; this ADR changes *where the IO happens* — host, not
  component). ADR-0002's relocation banner already notes the cloud module moved;
  this ADR moves its IO to the host sink.

## Glossary

New terms recorded in `CONTEXT.md` (and the stale §"Component Deps" / §"Runtime
Services" sections rewritten to post-re-host reality — see CONTEXT reconciliation):

- **CloudRequest** — an outbound cloud call recorded as an `Effects` field; the
  sans-IO replacement for the in-component async spawn.
- **perform_cloud** — the `EffectsSink` hook (ADR-0008) each host implements to
  perform a `CloudRequest`; result re-enters via `inject_event`.
- **Cloud Adapter (direct / proxy)** — per-host, per-provider strategy for
  performing a `CloudRequest`: straight to the provider, or via the `apps/server`
  tRPC proxy.

## References

- `apps/web/src-tauri/src/runtime/cloud/{mqtt,llm,figma}.rs` — cloud nodes (config → core; IO → host sink).
- `apps/web/src-tauri/src/runtime/host.rs:94-196` — `ChannelEmitter`, `ActorMsg::Inject`, `register_cloud_nodes` (collapses to `register_cloud`).
- `crates/microflow-core/src/runtime/context.rs` — `Effects` gains `cloud_requests`; `EffectsSink::perform_cloud`.
- `crates/microflow-core/src/runtime/registry.rs` — `register_cloud::<B>` helper.
- `crates/microflow-runtime-wasm/src/lib.rs` — gains `injectEvent`/`resolveCloud`.
- `apps/web/src/lib/firmata/flow-reactor.ts` — browser `perform_cloud`.
- `apps/server` + `packages/api` `appRouter` — `cloud.*` proxy procedures.
- [ADR-0006](0006-rehost-runtime-on-core.md) — sans-IO `Effects` seam this extends to cloud.
- [ADR-0008](0008-effects-apply-policy.md) — the `EffectsSink` this adds `perform_cloud` to.
- [ADR-0002](0002-per-capability-service-traits.md) — capability traits (still hold); IO location changes.
