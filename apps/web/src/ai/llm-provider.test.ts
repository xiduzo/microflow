// The LLM provider settings: what is typed is shown at once and settles once
// the typing stopped; what is added, removed or made the default settles at
// once. A provider is checked (status probe, model list) with what settled.

import { describe, expect, test } from "bun:test";
import type { StateStorage } from "zustand/middleware";
import { FakeTimers } from "@/lib/fake-timers";
import { createLlmProviderStore, PROVIDER_SETTINGS_SETTLE_MS, type LlmProviderConfig } from "./llm-provider";

const OPENAI: Omit<LlmProviderConfig, "id"> = {
  name: "OpenAI",
  kind: "http",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-1",
  model: "gpt-4o-mini",
  isDefault: true,
};

function memoryStorage(): StateStorage & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    getItem: (name) => saved.get(name) ?? null,
    setItem: (name, value) => void saved.set(name, value),
    removeItem: (name) => void saved.delete(name),
  };
}

function setup(storage = memoryStorage()) {
  const timers = new FakeTimers();
  const store = createLlmProviderStore({ timers, storage });
  const id = store.getState().addProvider(OPENAI);
  const keys = () => ({
    typed: store.getState().providers.map((provider) => provider.apiKey),
    settled: store.getState().settled.map((provider) => provider.apiKey),
  });
  return { store, timers, id, keys, storage };
}

describe("LLM provider settings", () => {
  test("a key typed a keystroke at a time settles once, after the typing stopped", () => {
    const { store, timers, id, keys } = setup();

    for (const key of ["s", "sk", "sk-", "sk-2"]) {
      store.getState().updateProvider(id, { apiKey: key });
      timers.advance(PROVIDER_SETTINGS_SETTLE_MS - 1);
    }
    expect(keys()).toEqual({ typed: ["sk-2"], settled: ["sk-1"] });

    timers.advance(1);
    expect(keys()).toEqual({ typed: ["sk-2"], settled: ["sk-2"] });
  });

  test("a provider added, removed or made the default settles at once, with what is typed", () => {
    const { store, id, keys } = setup();
    store.getState().updateProvider(id, { apiKey: "sk-2" });

    const other = store.getState().addProvider({ ...OPENAI, name: "Other", apiKey: "sk-o", isDefault: false });
    expect(keys()).toEqual({ typed: ["sk-2", "sk-o"], settled: ["sk-2", "sk-o"] });

    store.getState().setDefaultProvider(other);
    expect(store.getState().settled.map((provider) => provider.isDefault)).toEqual([false, true]);

    store.getState().deleteProvider(other);
    expect(store.getState().settled.map((provider) => [provider.apiKey, provider.isDefault])).toEqual([
      ["sk-2", true],
    ]);
  });

  test("settle settles what is typed now, and changes nothing when nothing is typed", () => {
    const { store, id, keys, timers } = setup();
    const before = store.getState().settled;
    store.getState().settle();
    expect(store.getState().settled).toBe(before);

    store.getState().updateProvider(id, { apiKey: "sk-2" });
    store.getState().settle();
    expect(keys()).toEqual({ typed: ["sk-2"], settled: ["sk-2"] });
    expect(timers.waiting).toBe(0);
  });

  test("the settings are kept as typed, and a store that loads them starts with them settled", async () => {
    const { store, id, storage } = setup();
    store.getState().updateProvider(id, { apiKey: "sk-typed" });

    const loaded = createLlmProviderStore({ timers: new FakeTimers(), storage });
    await loaded.persist.rehydrate();

    expect(loaded.getState().settled.map((provider) => provider.apiKey)).toEqual(["sk-typed"]);
    expect(loaded.getState().providers).toBe(loaded.getState().settled);
  });
});
