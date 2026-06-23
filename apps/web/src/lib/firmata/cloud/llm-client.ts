// Browser LLM transport for ADR-0009 Phase 3 (cloud-as-Effect, browser host).
//
// The wasm `Llm` node is sans-IO: it emits an `llmGenerate` `CloudRequest`; THIS
// is the browser half of what the desktop's `HttpLlmProvider` does natively —
// one POST to an OpenAI-compatible `/v1/chat/completions` endpoint. Kept a pure
// transport (provider connection in, text out / throws) so it unit-tests against
// a stubbed `fetch` with no runtime or store in scope. Provider resolution
// (providerId → baseUrl/apiKey) and result re-entry live in the reactor.
//
// Per ADR-0009 D4 the call is **direct**: the user's own key, in the user's own
// browser. CORS is the only practical blocker (a proxy fallback is Phase 4).

/** The connection half of an `LlmProviderConfig` — what a request needs. */
export type LlmProviderConn = {
  baseUrl: string;
  apiKey: string;
};

/** The request half carried by an `llmGenerate` cloud request. */
export type LlmGenerateInput = {
  model: string;
  system: string | null;
  prompt: string;
};

/**
 * POST one generation to an OpenAI-compatible endpoint and return the assistant
 * text. Mirrors the desktop `HttpLlmProvider::generate` byte-for-byte: trim a
 * trailing slash, append `/v1/chat/completions`, send `{model, messages, stream:
 * false}` with an optional `system` message, `Authorization: Bearer` only when a
 * key is set, and read `choices[0].message.content`.
 *
 * Throws on transport failure, non-2xx, or a response missing the content field.
 * Pass an `AbortSignal` for latest-wins cancellation (a re-trigger supersedes).
 */
export async function performLlmGenerate(
  provider: LlmProviderConn,
  input: LlmGenerateInput,
  signal?: AbortSignal,
): Promise<string> {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const url = `${base}/v1/chat/completions`;

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (input.system && input.system.length > 0) {
    messages.push({ role: "system", content: input.system });
  }
  messages.push({ role: "user", content: input.prompt });

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.apiKey.length > 0) headers.authorization = `Bearer ${provider.apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: input.model, messages, stream: false }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("LLM response missing choices[0].message.content");
  }
  return text;
}
