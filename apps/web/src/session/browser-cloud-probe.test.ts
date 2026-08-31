import { describe, expect, it } from "bun:test";
import { probeLlmProvider } from "./browser-cloud-probe";
import type { LlmProviderConfig } from "@/stores/llm-provider";

const provider: LlmProviderConfig = {
  id: "p1",
  name: "ollama",
  baseUrl: "http://localhost:11434/",
  apiKey: "",
  isDefault: true,
};

describe("probeLlmProvider", () => {
  it("GETs /v1/models on the trimmed base URL and reports reachability", async () => {
    const seen: string[] = [];
    const ok = await probeLlmProvider(provider, ((url: string) => {
      seen.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch);

    expect(seen).toEqual(["http://localhost:11434/v1/models"]);
    expect(ok).toBe("ok");
  });

  it("reports error for a refused request (mixed content / CORS both land here)", async () => {
    const status = await probeLlmProvider(provider, (() =>
      Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch);
    expect(status).toBe("error");
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
