# ADR-0021 — One LLM transport, in TypeScript, performed by the webview in both hosts

- **Status:** accepted — implemented (2026-08-31)
- **Date:** 2026-08-31
- **Deciders:** sander
- **Amends:** [ADR-0009](0009-cloud-sans-io-capability.md) (the split-transport
  half of it; the sans-IO node contract is untouched)

## Context

ADR-0009 made the `Llm` node sans-IO: it emits an `llmGenerate` `CloudRequest`
and each host performs it. That left two implementations of the same POST — the
browser's `fetch` in `lib/firmata/cloud/llm-client.ts` and the desktop's
`reqwest`-backed `HttpLlmProvider` in `runtime/services` — kept in step by
parity tests and by writing "mirrors the desktop `HttpLlmProvider` byte-for-byte"
at the top of the browser file.

Two things then came due at once:

1. **Streaming and tool calls** in the `Llm` node, which neither hand-rolled
   transport had.
2. **Ask AI**, an assistant that builds and debugs the flow you are looking at.

Both need the same machinery — a streaming chat/agent loop — which is a lot to
write once and absurd to write twice. Adopting `@tanstack/ai` gives it to us; the
question this ADR settles is where it runs.

The blocker for "just use it in both hosts" was never the SDK. It was CORS: a
Tauri webview requests from the `tauri.localhost` origin, and a laptop-local
Ollama or LM Studio refuses that. Performing LLM calls in Rust was how desktop
sidestepped it, and that is the whole reason the second implementation existed.

## Decision

**The LLM transport is TypeScript, and the webview performs it in both hosts.**

- `lib/ai/adapter.ts` turns a stored `LlmProviderConfig` into a TanStack AI
  adapter. `lib/firmata/cloud/llm-client.ts` is the one transport, used by the
  browser `CloudPerformer` and — via `hooks/use-llm-requests.ts` — by desktop.
- **The desktop actor stops performing LLM I/O.** `Actor::perform_cloud`
  forwards an `LlmGenerate` request to the webview as an `llm-request` event and
  returns, exactly as it already did for `AudioPlay`/`AudioStop`. Results
  re-enter through a new `llm_result` command onto the existing
  `ActorMsg::Inject`.
- **CORS is solved by swapping `fetch`, not by moving the code.** `hostFetch()`
  in `lib/ai/endpoint.ts` returns the page's `fetch` in a browser and
  `@tauri-apps/plugin-http`'s in the desktop webview. The latter performs the
  request in Rust — no origin, no preflight — so the desktop keeps exactly the
  reach it had.
- **Deleted:** `src-tauri/src/llm/`, `HttpLlmProvider`, `LlmRegistry`,
  `LlmProvider`, and the `llm_sync_providers` / `llm_test_provider` commands.
  Providers are no longer pushed to the host at all; the webview resolves
  `providerId` from its own store at request time.
- `CloudRequestKind::LlmGenerate` **does not change**. No node changes, no ts-rs
  churn, no ADR-0007 catalog churn. Only who performs the request moved.

### Consequences worth stating plainly

- **Parity stops being a thing tests have to catch.** There is one
  implementation, so the two hosts cannot disagree about streaming, error text,
  or how a base URL is normalised. `host.rs`'s two LLM transport tests are gone;
  `cloud-performer.test.ts` is now simply *the* test for LLM generation, and
  `perform_cloud_ignores_llm_generate` pins the interception contract.
- **Streaming for free.** `Llm` already declares `thinking`/`value`/`done`, so
  deltas re-inject on `value` and a downstream `Monitor` fills in as the model
  writes.
- **The desktop's LLM path now depends on the webview being alive.** This is not
  a new dependency in practice: the desktop app *is* the webview, there is no
  headless mode, and audio already relies on it for the same reason.
- **A capability widening on paper, not in fact.** `capabilities/default.json`
  grants `http:default` for `http://*` and `https://*`, because LLM endpoints are
  whatever the user configures. Before this change the same requests were made
  from Rust by `HttpLlmProvider`, unscoped. Only the caller moved.
- **Bundle.** The SDK is behind dynamic imports (`llm-client`, the Ask AI panel),
  and the SDK-free half of the adapter lives in `lib/ai/endpoint.ts` so the
  config page's reachability probe does not drag it into the main chunk. Net
  effect on the main chunk: +55 kB raw, +18 kB gzip.

## Rejected

- **A server-side proxy** for the chat loop (which is what `useChat` from
  `@tanstack/ai-react` assumes). It would route the user's own key — and their
  laptop-local endpoint, which our server cannot reach anyway — through us.
  ADR-0009 D4 already settled this: direct, the user's own key, no proxy. Ask AI
  drives `chat()` in the page instead.
- **A native `@tanstack/ai-ollama` adapter** alongside the OpenAI-compatible one,
  for better tool-calling on small local models. Its client cannot take a custom
  `fetch` (so it could not use `hostFetch`, so it would fail on CORS on desktop
  — the exact problem this ADR exists to remove) and it pulls a Node-targeted
  `ollama` build into the web bundle. Ollama's `/v1` shim speaks
  chat-completions including tools. Revisit only if that shim proves inadequate
  in practice.
- **Keeping the Rust transport and adding TanStack AI only in the browser.** That
  is the status quo plus a third implementation.

## Ask AI, which this enables

Not a separate ADR because it introduces no new seam — it is a consumer of two
that already exist:

- Tools in `lib/ai/flow-tools.ts` act on the session's `FlowDocument`, the same
  API the canvas uses. An AI edit is therefore indistinguishable from a human
  one: it syncs to collaborators, feeds the `FlowUpdateDispatcher`, reaches a
  connected board, and lands on the undo stack. None of that needed building.
- The model's vocabulary (`lib/ai/catalog-prompt.ts`) is generated from
  `NODE_REGISTRY` plus `COMPONENT_PORTS`/`COMPONENT_EMITS` — the sets the Catalog
  Parity Guard pins to the Rust `ports()`/`emits()` (ADR-0007). The catalogue the
  model reads cannot drift from the one the runtime enforces.
- **The write path is treated as a trust boundary.** A model invents field names,
  handles and enum values, and its output lands in a shared, persisted Yjs
  document. Nothing reaches it without passing the node's own zod schema (now
  exposed on `NODE_REGISTRY[type].schema`) and the generated handle sets.
  Rejections are returned to the model as tool *results*, not thrown, so it
  corrects itself instead of the turn dying.
- Three write modes — `auto`, `confirm` (stage, then apply as one undo step),
  `read-only` (the write tools are not registered at all). A read-only flow
  forces `read-only` regardless of the setting.
