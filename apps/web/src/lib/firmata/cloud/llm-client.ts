// The LLM transport for the `Llm` node — in BOTH hosts (ADR-0021).
//
// The wasm/core `Llm` node is sans-IO: it emits an `llmGenerate` `CloudRequest`
// and the host performs it. Before ADR-0021 each host performed it its own way
// (browser `fetch` here, desktop `reqwest` in `runtime/services`), kept honest
// by parity tests. Now there is one implementation — this one — and the desktop
// routes its requests up to the webview to run it, so the two hosts cannot
// drift apart in the first place.
//
// Kept a pure transport (provider connection in, text out / throws) so it
// unit-tests against a stubbed adapter with no runtime or store in scope.
// Provider resolution (providerId -> connection) and result re-entry live in
// the `CloudPerformer`.
//
// Per ADR-0009 D4 the call is **direct**: the user's own key, from the user's
// own machine. `hostFetch` in `lib/ai/adapter` is what makes that work on
// desktop without CORS.

import { chat, EventType } from "@tanstack/ai";

import { adapterFor, type LlmProviderConn } from "@/lib/ai/adapter";

export type { LlmProviderConn };

/** The request half carried by an `llmGenerate` cloud request. */
export type LlmGenerateInput = {
  model: string;
  system: string | null;
  prompt: string;
};

/**
 * Stream one generation and return the full assistant text.
 *
 * `onDelta` receives the text so far (not the increment) on every chunk, which
 * is what the `Llm` node's `value` handle wants: each inject overwrites the
 * previous, so a downstream `Monitor` shows the answer growing rather than a
 * stutter of fragments. Callers that only want the final text can omit it.
 *
 * Throws on transport failure or a provider error. Pass an `AbortSignal` for
 * latest-wins cancellation (a re-trigger supersedes its predecessor).
 */
export async function performLlmGenerate(
  provider: LlmProviderConn,
  input: LlmGenerateInput,
  signal?: AbortSignal,
  onDelta?: (textSoFar: string) => void,
): Promise<string> {
  const adapter = await adapterFor(provider, input.model);

  // `chat` takes an AbortController, not a signal. Callers own the real one
  // (the performer's latest-wins table), so bridge rather than take ownership:
  // an already-aborted signal short-circuits before any network call.
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const stream = chat({
    adapter,
    systemPrompts: input.system && input.system.length > 0 ? [input.system] : undefined,
    messages: [{ role: "user", content: input.prompt }],
    abortController: controller,
    stream: true,
  });

  let text = "";
  for await (const chunk of stream) {
    if (chunk.type === EventType.RUN_ERROR) {
      throw new Error(chunk.message || "LLM request failed");
    }
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && chunk.delta) {
      text += chunk.delta;
      onDelta?.(text);
    }
  }

  return text;
}

function abortError(): Error {
  const error = new Error("LLM request aborted");
  error.name = "AbortError";
  return error;
}
