import { describe, expect, it } from "bun:test";

import { fetchModels } from "./models";

/** A `fetch` for one canned reply. Injected rather than swapped onto
 *  `globalThis`, which leaks into every other test file in the run. */
function stub(handler: (url: string) => Response): typeof fetch {
  return ((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))) as typeof fetch;
}

describe("fetchModels", () => {
  it("reads the OpenAI-compatible listing off the same endpoint the probe uses", async () => {
    let asked = "";
    const models = await fetchModels(
      { baseUrl: "http://localhost:11434", apiKey: "" },
      stub((url) => {
        asked = url;
        return Response.json({ data: [{ id: "qwen2.5" }, { id: "llama3.2" }] });
      }),
    );

    // Sorted, so the dropdown does not reorder itself between providers.
    expect(models).toEqual(["llama3.2", "qwen2.5"]);
    // `/v1` is appended for a provider saved before it was part of a base URL.
    expect(asked).toBe("http://localhost:11434/v1/models");
  });

  it("falls back to the known list rather than emptying the dropdown", async () => {
    // An endpoint that is down, or one that answers with something else, must
    // still leave the user something to pick — and must never throw into the
    // settings pane they are typing in.
    expect(
      await fetchModels(
        { baseUrl: "https://api.openai.com/v1" },
        stub(() => new Response("nope", { status: 500 })),
      ),
    ).toEqual(["gpt-4o-mini", "gpt-4o", "o3-mini"]);

    expect(
      await fetchModels(
        { baseUrl: "http://localhost:11434" },
        stub(() => {
          throw new Error("connection refused");
        }),
      ),
    ).toContain("llama3.2");
  });

  it("gives a CLI without a listing its known aliases", async () => {
    // `claude` has no listing subcommand, and off-desktop no CLI can be asked
    // at all — either way the dropdown shows the aliases rather than nothing.
    expect(await fetchModels({ kind: "cli", baseUrl: "claude" })).toEqual([
      "sonnet",
      "opus",
      "haiku",
    ]);
  });
});
