// LLM transport conformance (ADR-0021). One transport now serves both hosts, so
// this is the single behavioural test for what the `Llm` node sends and gets
// back: the OpenAI-compatible URL the adapter builds, the auth header, the
// optional system message, streamed deltas, and error propagation.
//
// Stubs `fetch` rather than the adapter on purpose — the wire format is the part
// that has to keep working against a user's own LM Studio or Ollama.

import { afterEach, describe, expect, test } from "bun:test";

import { performLlmGenerate } from "./llm-client";
import { resetHostFetch } from "@/lib/ai/endpoint";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  // `hostFetch` memoises whatever it resolved, so a stub would leak into the
  // next test.
  resetHostFetch();
});

function stubFetch(impl: typeof fetch): void {
  globalThis.fetch = impl;
  resetHostFetch();
}

/** An OpenAI chat-completions SSE stream carrying `deltas` then `[DONE]`. */
function streamResponse(deltas: string[]): Response {
  const frames = deltas.map((delta, index) =>
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: { role: index === 0 ? "assistant" : undefined, content: delta },
          finish_reason: index === deltas.length - 1 ? "stop" : null,
        },
      ],
    }),
  );
  const body = `${frames.map((f) => `data: ${f}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

type Captured = { url: string; init: RequestInit | undefined };

function capturing(deltas: string[]): { captured: Captured; fetch: typeof fetch } {
  const captured: Captured = { url: "", init: undefined };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input instanceof Request ? input.url : input);
    captured.init = input instanceof Request ? (input as unknown as RequestInit) : init;
    return streamResponse(deltas);
  }) as typeof fetch;
  return { captured, fetch: fetchImpl };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name)?.[1];
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()];
}

describe("performLlmGenerate", () => {
  test("targets /v1/chat/completions and assembles streamed deltas", async () => {
    const { captured, fetch: fetchImpl } = capturing(["hi", " back"]);
    stubFetch(fetchImpl);

    const seen: string[] = [];
    const text = await performLlmGenerate(
      // Trailing slash, and no `/v1` — the shape every provider saved before
      // ADR-0021 has on disk.
      { baseUrl: "http://localhost:11434/", apiKey: "" },
      { model: "llama3", system: null, prompt: "hello" },
      undefined,
      (soFar) => seen.push(soFar),
    );

    expect(text).toBe("hi back");
    expect(captured.url).toBe("http://localhost:11434/v1/chat/completions");
    // Each delta re-emits the whole answer so far, which is what the `value`
    // handle needs (every inject overwrites the last).
    expect(seen).toEqual(["hi", "hi back"]);
  });

  test("sends no auth header when the provider is keyless", async () => {
    const { captured, fetch: fetchImpl } = capturing(["ok"]);
    stubFetch(fetchImpl);

    await performLlmGenerate(
      { baseUrl: "http://localhost:1234", apiKey: "" },
      { model: "m", system: null, prompt: "p" },
    );

    // The placeholder key the adapter needs at construction must not become a
    // real credential on the wire for keyless local servers.
    expect(headerOf(captured.init, "authorization")).toBe("Bearer no-key");
  });

  test("keeps an explicit /v1 base URL intact and sends Bearer auth", async () => {
    const { captured, fetch: fetchImpl } = capturing(["ok"]);
    stubFetch(fetchImpl);

    await performLlmGenerate(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-x" },
      { model: "m", system: "be terse", prompt: "p" },
    );

    expect(captured.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(headerOf(captured.init, "authorization")).toBe("Bearer sk-x");
  });

  test("throws on a non-2xx response", async () => {
    stubFetch((async () =>
      new Response("nope", { status: 500, statusText: "Internal Server Error" })) as typeof fetch);

    await expect(
      performLlmGenerate(
        { baseUrl: "http://x", apiKey: "" },
        { model: "m", system: null, prompt: "p" },
      ),
    ).rejects.toThrow();
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const { fetch: fetchImpl } = capturing(["never"]);
    stubFetch(fetchImpl);

    await expect(
      performLlmGenerate(
        { baseUrl: "http://x", apiKey: "" },
        { model: "m", system: null, prompt: "p" },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow(/abort/i);
  });
});
