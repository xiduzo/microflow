// The one place a stored `LlmProviderConfig` becomes a TanStack AI adapter.
//
// Both AI surfaces resolve through here — the `Llm` flow node's transport
// (`lib/firmata/cloud/llm-client.ts`) and the Ask AI assistant
// (`components/flow/ask-ai`) — so a provider that answers in one answers in the
// other, and neither owns a bespoke HTTP path.
//
// ADR-0021: the transport is TypeScript in BOTH hosts. The desktop no longer
// performs LLM calls in Rust; it routes the request up to the webview and this
// module runs it there. The only host difference is {@link hostFetch} — see its
// doc for why that is the entire CORS story.
//
// One HTTP wire protocol is supported: OpenAI chat-completions. That is not a
// limitation in practice — OpenAI, OpenRouter, LM Studio, llama.cpp, vLLM and
// Ollama all speak it, which is why the existing provider store only ever held
// a base URL and a key. A native adapter for one of them would need its own
// client construction, and `@tanstack/ai-ollama` in particular cannot take a
// custom `fetch` and pulls a Node-targeted build into the web bundle.
//
// What a small local model does need is `tool-call-recovery.ts`, wrapped around
// the transport below: the wire format is right, the model's use of it is not.

import { OpenAIChatCompletionsTextAdapter } from "@tanstack/ai-openai";
import type { AnyTextAdapter } from "@tanstack/ai";

import { hostFetch, normalizeBaseUrl } from "./endpoint";
import { recoverTextToolCalls } from "./tool-call-recovery";

export { hostFetch, normalizeBaseUrl, resetHostFetch } from "./endpoint";

/** The connection half of an `LlmProviderConfig` — what a request needs. */
export type LlmProviderConn = {
  /** `"cli"` routes to a local agent CLI instead of an HTTP endpoint; absent
   *  means `"http"`, which is every configuration saved before CLIs existed. */
  kind?: "http" | "cli";
  baseUrl: string;
  apiKey: string;
};

/**
 * Build the text adapter for one provider + model.
 *
 * Constructed directly rather than through `createOpenaiChatCompletions`
 * because that helper takes the key positionally and exposes no way to pass a
 * custom `fetch`, which is what {@link hostFetch} exists to supply.
 *
 * The adapter types its model parameter as the union of OpenAI's own catalogue,
 * but the same wire format serves every compatible server — where the model name
 * is whatever the user pulled (`llama3.2`, `qwen2.5-coder:7b`). The cast is
 * that, and only that: an arbitrary model string is the normal case here, not an
 * escape hatch.
 */
export async function adapterFor(
  provider: LlmProviderConn,
  model: string,
): Promise<AnyTextAdapter> {
  // A local CLI is a subprocess, not an endpoint — a different transport
  // entirely, so it gets its own adapter rather than a branch inside this one.
  // Loaded on demand so the web build never pulls it in.
  if (provider.kind === "cli") {
    const { cliAdapterFor } = await import("./cli-adapter");
    const adapter = cliAdapterFor(provider.baseUrl, model);
    if (!adapter) throw new Error(`${provider.baseUrl} is not a supported local CLI`);
    return adapter;
  }

  // Wrapped so a tool call the model typed out as text still runs — the
  // difference between Ask AI editing the flow and only describing it on a
  // small local model. See `tool-call-recovery.ts`.
  const fetchImpl = recoverTextToolCalls(await hostFetch());

  return new OpenAIChatCompletionsTextAdapter(
    {
      // Compatible servers usually ignore the key, but the OpenAI client
      // requires one at construction — a placeholder keeps keyless local
      // endpoints working without a branch here.
      apiKey: provider.apiKey.length > 0 ? provider.apiKey : "no-key",
      baseURL: normalizeBaseUrl(provider.baseUrl),
      fetch: fetchImpl,
      // The key is the user's own and already lives in this browser
      // (`stores/llm-provider`), so the SDK's browser guard is telling us
      // something we decided in ADR-0009 D4.
      dangerouslyAllowBrowser: true,
    },
    model as never,
  ) as unknown as AnyTextAdapter;
}
