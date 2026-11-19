/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Token } from "@penpot/plugin-types";
import { type PenpotTokens, createPenpotAdapter } from "./tokens";

type FileToken = {
  id: string;
  name: string;
  type: string;
  /** What the user typed: a literal or a reference such as `{brand.red}`. */
  value: unknown;
  /** What Penpot resolved it to: `null` in an inactive set, `undefined` when it does not resolve. */
  resolvedValue?: unknown;
  /** Assigning `value` throws. */
  readOnly?: boolean;
};

/** A Penpot file's token catalog in memory, holding `tokens` in the MHB set. */
function penpotFile(tokens: FileToken[] | null) {
  const added: Array<{ name: string; active?: boolean }> = [];
  const asToken = (token: FileToken) =>
    ({
      ...token,
      get value() {
        return token.value;
      },
      set value(next: unknown) {
        if (token.readOnly) throw new Error("token is locked");
        token.value = next;
      },
    }) as unknown as Token;
  const set = (list: FileToken[]) => ({
    name: "MHB",
    tokens: list.map(asToken),
    getTokenById: (id: string) => list.map(asToken).find((token) => token.id === id),
  });

  const catalog: PenpotTokens = {
    sets: tokens ? [set(tokens)] : [],
    addSet(created) {
      added.push(created);
      // Penpot adds the set to the catalog later, not during this call.
      return set([]);
    },
  };
  return { adapter: createPenpotAdapter(() => catalog), added, tokens: tokens ?? [] };
}

const values = async (tokens: FileToken[]) =>
  Object.fromEntries(
    (await penpotFile(tokens).adapter.readSnapshot()).map((entry) => [
      entry.variable.name,
      entry.value,
    ]),
  );

describe("reading the MHB token set", () => {
  test("reads a token by its ID, name and bridge type", async () => {
    const { adapter } = penpotFile([
      { id: "3f9a2b1c", name: "level", type: "number", value: "5", resolvedValue: 5 },
    ]);
    expect(await adapter.readSnapshot()).toEqual([
      { variable: { id: "3f9a2b1c", name: "level", resolvedType: "FLOAT" }, value: 5 },
    ]);
  });

  test("creates the set once, active, when the file has none", async () => {
    const { adapter, added } = penpotFile(null);
    expect(await adapter.readSnapshot()).toEqual([]);
    expect(await adapter.readSnapshot()).toEqual([]);
    expect(added).toEqual([{ name: "MHB", active: true }]);
  });

  test("maps every token type onto a bridge type, or leaves it out", async () => {
    const numeric = [
      "number",
      "dimension",
      "opacity",
      "rotation",
      "sizing",
      "spacing",
      "borderWidth",
      "borderRadius",
      "fontSizes",
      "letterSpacing",
    ];
    const text = ["fontWeights", "textCase", "textDecoration"];
    const { adapter } = penpotFile([
      { id: "c", name: "color", type: "color", value: "#ff0000", resolvedValue: "#ff0000" },
      ...numeric.map((type) => ({ id: type, name: type, type, value: "12px", resolvedValue: "12px" })),
      ...text.map((type) => ({ id: type, name: type, type, value: "bold", resolvedValue: "bold" })),
      { id: "f", name: "fontFamilies", type: "fontFamilies", value: "Inter", resolvedValue: "Inter" },
      { id: "s", name: "shadow", type: "shadow", value: [], resolvedValue: [] },
      { id: "t", name: "typography", type: "typography", value: [], resolvedValue: [] },
    ]);

    const types = (await adapter.readSnapshot()).map((entry) => [
      entry.variable.name,
      entry.variable.resolvedType,
      entry.value,
    ]);
    expect(types).toEqual([
      ["color", "COLOR", { r: 1, g: 0, b: 0, a: 1 }],
      ...numeric.map((type) => [type, "FLOAT", 12]),
      ...text.map((type) => [type, "STRING", "bold"]),
      ["fontFamilies", "STRING", "Inter"],
    ]);
  });

  test("leaves out tokens of an inactive set and tokens that do not resolve", async () => {
    expect(
      await values([
        { id: "1", name: "inactive", type: "number", value: "5", resolvedValue: null },
        { id: "2", name: "dangling", type: "number", value: "{gone}", resolvedValue: undefined },
        { id: "3", name: "not a number", type: "number", value: "abc", resolvedValue: "abc" },
        { id: "4", name: "level", type: "number", value: "5", resolvedValue: 5 },
      ]),
    ).toEqual({ level: 5 });
  });

  test("recovers a color's alpha, which Penpot drops when it resolves the token", async () => {
    const colors = await values([
      { id: "1", name: "literal", type: "color", value: "#ff000080", resolvedValue: "#ff0000" },
      { id: "2", name: "reference", type: "color", value: "{brand.green}", resolvedValue: "#00ff00" },
      { id: "3", name: "other", type: "color", value: "#0000ff80", resolvedValue: "#00ff00" },
    ]);

    expect(colors.literal).toMatchObject({ r: 1, g: 0, b: 0 });
    expect((colors.literal as { a: number }).a).toBeCloseTo(0.502, 3);
    expect(colors.reference).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(colors.other).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  });

  test("joins font families, which Penpot resolves word by word", async () => {
    expect(
      await values([
        {
          id: "1",
          name: "words",
          type: "fontFamilies",
          value: "IBM Plex Mono, serif",
          resolvedValue: [["IBM", "Plex", "Mono"], "serif"],
        },
        { id: "2", name: "text", type: "fontFamilies", value: "Inter", resolvedValue: "Inter" },
        { id: "3", name: "odd", type: "fontFamilies", value: "Inter", resolvedValue: 5 },
      ]),
    ).toEqual({ words: "IBM Plex Mono, serif", text: "Inter" });
  });
});

describe("writing a value", () => {
  test("stores each bridge value in the token's own notation", async () => {
    const { adapter, tokens } = penpotFile([
      { id: "1", name: "tint", type: "color", value: "#000000", resolvedValue: "#000000" },
      { id: "2", name: "glass", type: "color", value: "#000000", resolvedValue: "#000000" },
      { id: "3", name: "level", type: "spacing", value: "0", resolvedValue: 0 },
      { id: "4", name: "label", type: "textCase", value: "none", resolvedValue: "none" },
    ]);

    expect(await adapter.writeValue("1", { r: 1, g: 0, b: 0, a: 1 })).toBeNull();
    expect(await adapter.writeValue("2", { r: 0, g: 1, b: 0, a: 0.5 })).toBeNull();
    expect(await adapter.writeValue("3", 12.5)).toBeNull();
    expect(await adapter.writeValue("4", "uppercase")).toBeNull();
    expect(tokens.map((token) => token.value)).toEqual(["#ff0000", "#00ff0080", "12.5", "uppercase"]);
  });

  test("rejects a write to a token that is gone", async () => {
    const { adapter } = penpotFile([]);
    expect(await adapter.writeValue("gone", 1)).toEqual({ message: "That token no longer exists" });
  });

  test("rejects a value the token cannot hold, and keeps the token", async () => {
    const { adapter, tokens } = penpotFile([
      { id: "1", name: "level", type: "number", value: "5", resolvedValue: 5 },
      { id: "2", name: "tint", type: "color", value: "#000000", resolvedValue: "#000000" },
      { id: "3", name: "drop", type: "shadow", value: [], resolvedValue: [] },
    ]);

    expect(await adapter.writeValue("1", "abc")).toEqual({ message: "level cannot hold that value" });
    expect(await adapter.writeValue("2", "nope")).toEqual({ message: "tint cannot hold that value" });
    expect(await adapter.writeValue("3", 1)).toEqual({ message: "drop cannot hold that value" });
    expect(tokens.map((token) => token.value)).toEqual(["5", "#000000", []]);
  });

  test("rejects a write Penpot refuses, with the cause", async () => {
    const { adapter } = penpotFile([
      { id: "1", name: "level", type: "number", value: "5", resolvedValue: 5, readOnly: true },
    ]);
    expect(await adapter.writeValue("1", 6)).toEqual({
      message: "Could not update level",
      cause: new Error("token is locked"),
    });
  });
});
