import { describe, expect, it } from "bun:test";

import { comboEntries } from "./connection-console";

const MODELS = ["llama3.2", "qwen2.5:7b"];

describe("comboEntries", () => {
  it("offers the whole list whatever is already set", () => {
    // The `<datalist>` this replaced filtered against the current value, so the
    // list a user wanted to browse was hidden by the value they meant to change.
    expect(comboEntries(MODELS, "", "llama3.2").map((entry) => entry.value)).toEqual(MODELS);
  });

  it("offers a typed model the endpoint never listed", () => {
    // Local users pull models we cannot know about, so the list is suggestions.
    const [first] = comboEntries(MODELS, " deepseek-r1:8b ", "");
    expect(first).toMatchObject({ value: "deepseek-r1:8b", kind: "custom" });

    // Typing a name that *is* listed adds nothing: the list already has it.
    expect(comboEntries(MODELS, "llama3.2", "").every((entry) => entry.kind === "option")).toBe(true);
  });

  it("hands a set value back to the fallback, and filters that entry on a word", () => {
    const withValue = comboEntries(MODELS, "", "llama3.2", "the CLI's own default");
    // An empty model is a real choice — a CLI then runs its own default — so it
    // has to be reachable again after picking something.
    expect(withValue[0]).toMatchObject({ value: "", kind: "fallback" });
    // Its stored value is empty, which as a search key would match everything.
    expect(withValue[0].search).not.toBe("");

    // Nothing to hand back when nothing is set, and none at all without a
    // fallback to name.
    expect(comboEntries(MODELS, "", "", "a default").some((e) => e.kind === "fallback")).toBe(false);
    expect(comboEntries(MODELS, "", "llama3.2").some((e) => e.kind === "fallback")).toBe(false);
  });
});
