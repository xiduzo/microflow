// Browser LLM transport conformance (ADR-0009 Phase 3). Asserts `performLlmGenerate`
// mirrors the desktop `HttpLlmProvider`: OpenAI-compatible URL + body, optional
// system message, Bearer only when keyed, and `choices[0].message.content` out.

import { afterEach, describe, expect, test } from "bun:test";
import { performLlmGenerate } from "../cloud/llm-client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: typeof fetch): void {
  globalThis.fetch = impl;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe("performLlmGenerate", () => {
  test("posts OpenAI-compatible body to /v1/chat/completions, no auth when keyless", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    stubFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(_input);
      capturedInit = init;
      return jsonResponse({ choices: [{ message: { content: "hi back" } }] });
    });

    const text = await performLlmGenerate(
      { baseUrl: "http://localhost:11434/", apiKey: "" },
      { model: "llama3", system: null, prompt: "hello" },
    );

    expect(text).toBe("hi back");
    // Trailing slash trimmed, suffix appended (matches desktop trim_end_matches).
    expect(capturedUrl).toBe("http://localhost:11434/v1/chat/completions");
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(String(capturedInit?.body)) as unknown;
    expect(body).toEqual({
      model: "llama3",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
  });

  test("prepends a system message and sends Bearer auth when keyed", async () => {
    let body: { messages: Array<{ role: string; content: string }> } | undefined;
    let auth: string | undefined;
    stubFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      auth = ((init?.headers ?? {}) as Record<string, string>).authorization;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    await performLlmGenerate(
      { baseUrl: "https://api.openrouter.ai", apiKey: "sk-x" },
      { model: "m", system: "be terse", prompt: "p" },
    );

    expect(auth).toBe("Bearer sk-x");
    expect(body?.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "p" },
    ]);
  });

  test("throws on a non-2xx response", async () => {
    stubFetch(async () => new Response("nope", { status: 500, statusText: "Internal Server Error" }));
    await expect(
      performLlmGenerate({ baseUrl: "http://x", apiKey: "" }, { model: "m", system: null, prompt: "p" }),
    ).rejects.toThrow(/500/);
  });

  test("throws when the response is missing message content", async () => {
    stubFetch(async () => jsonResponse({ choices: [] }));
    await expect(
      performLlmGenerate({ baseUrl: "http://x", apiKey: "" }, { model: "m", system: null, prompt: "p" }),
    ).rejects.toThrow(/content/);
  });
});
