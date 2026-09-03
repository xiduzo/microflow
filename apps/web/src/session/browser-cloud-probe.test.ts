import { describe, expect, it } from "bun:test";
import { isProbeOk, probeLlmProvider, probeStatus } from "./browser-cloud-probe";
import type { LlmProviderConfig } from "@/stores/llm-provider";

const provider: LlmProviderConfig = {
  id: "p1",
  name: "ollama",
  baseUrl: "http://localhost:11434/",
  apiKey: "",
  isDefault: true,
};

const responding = (status: number) =>
  (() => Promise.resolve(new Response("{}", { status }))) as unknown as typeof fetch;

describe("probeLlmProvider", () => {
  it("GETs /v1/models on the trimmed base URL and reports reachability", async () => {
    const seen: string[] = [];
    const outcome = await probeLlmProvider(provider, ((url: string) => {
      seen.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch);

    expect(seen).toEqual(["http://localhost:11434/v1/models"]);
    expect(outcome).toEqual({ kind: "ok" });
  });

  it("sends the API key only when one is set", async () => {
    let headers: Record<string, string> = {};
    await probeLlmProvider({ ...provider, apiKey: "sk-1" }, ((_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch);
    expect(headers.authorization).toBe("Bearer sk-1");
  });
});

describe("the probe says why it failed", () => {
  // The point of the reason union: these three used to be one "error", and the
  // config page guessed between them from the URL — so a bad key was reported
  // as a CORS problem.

  it("distinguishes a thrown fetch as unreachable", async () => {
    const outcome = await probeLlmProvider(provider, (() =>
      Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch);
    expect(outcome).toEqual({ kind: "unreachable" });
  });

  it("reports a rejected key as an http error, not as unreachable", async () => {
    const outcome = await probeLlmProvider(provider, responding(401));
    expect(outcome).toEqual({ kind: "httpError", status: 401 });
  });

  it("carries the status through for any other non-2xx", async () => {
    const outcome = await probeLlmProvider(provider, responding(404));
    expect(outcome).toEqual({ kind: "httpError", status: 404 });
  });

  it("treats every 2xx as reachable", async () => {
    expect(await probeLlmProvider(provider, responding(204))).toEqual({ kind: "ok" });
  });
});

describe("outcome to status", () => {
  it("collapses to the dot the store draws", () => {
    expect(probeStatus({ kind: "ok" })).toBe("ok");
    expect(probeStatus({ kind: "unreachable" })).toBe("error");
    expect(probeStatus({ kind: "httpError", status: 401 })).toBe("error");
    expect(probeStatus({ kind: "mixedContent" })).toBe("error");
    expect(probeStatus({ kind: "cliNotFound", bin: "claude" })).toBe("error");
  });

  it("agrees with isProbeOk", () => {
    expect(isProbeOk({ kind: "ok" })).toBe(true);
    expect(isProbeOk({ kind: "httpError", status: 500 })).toBe(false);
  });
});
