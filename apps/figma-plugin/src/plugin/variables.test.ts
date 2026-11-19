/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { type FigmaVariables, createFigmaAdapter } from "./variables";

type FileVariable = {
  id: string;
  name: string;
  type: string;
  /** The collection it lives in; `MHB` when left out. */
  collection?: string;
  /** Its value in that collection's default mode. */
  value: unknown;
  /** `setValueForMode` throws, as Figma does for a value the variable cannot take. */
  readOnly?: boolean;
};

const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });

/** A Figma file in memory: just enough of `figma.variables` for the adapter. */
function figmaFile(variables: FileVariable[], collections = ["MHB", "Brand"]) {
  const created: string[] = [];
  const collection = (name: string) => ({
    name,
    defaultModeId: `${name}:default`,
    variableIds: variables.filter((v) => (v.collection ?? "MHB") === name).map((v) => v.id),
  });

  const api: FigmaVariables = {
    getLocalVariableCollectionsAsync: async () => collections.map(collection),
    createVariableCollection(name) {
      collections.push(name);
      created.push(name);
      return collection(name);
    },
    getVariableCollectionByIdAsync: async (id) => (collections.includes(id) ? collection(id) : null),
    getVariableByIdAsync: async (id) => {
      const variable = variables.find((v) => v.id === id);
      if (!variable) return null;
      const home = variable.collection ?? "MHB";
      return {
        name: variable.name,
        resolvedType: variable.type as VariableResolvedDataType,
        variableCollectionId: home,
        valuesByMode: {
          [`${home}:default`]: variable.value as VariableValue,
          [`${home}:dark`]: "the other mode" as VariableValue,
        },
        setValueForMode(modeId, value) {
          if (variable.readOnly) throw new Error("cannot set this variable");
          if (modeId !== `${home}:default`) throw new Error(`unexpected mode ${modeId}`);
          variable.value = value;
        },
      };
    },
  };
  return { adapter: createFigmaAdapter(api), created, variables };
}

const values = async (variables: FileVariable[]) =>
  Object.fromEntries(
    (await figmaFile(variables).adapter.readSnapshot()).map((entry) => [
      entry.variable.name,
      entry.value,
    ]),
  );

describe("reading the MHB collection", () => {
  test("reads each variable's value in the collection's default mode", async () => {
    const { adapter } = figmaFile([
      { id: "VariableID:1:1", name: "on", type: "BOOLEAN", value: true },
      { id: "VariableID:1:2", name: "level", type: "FLOAT", value: 0.5 },
      { id: "VariableID:1:3", name: "label", type: "STRING", value: "hello" },
      { id: "VariableID:1:4", name: "tint", type: "COLOR", value: { r: 1, g: 0, b: 0, a: 0.5 } },
      { id: "VariableID:9:9", name: "brand", type: "FLOAT", collection: "Brand", value: 7 },
    ]);

    expect(await adapter.readSnapshot()).toEqual([
      { variable: { id: "VariableID:1:1", name: "on", resolvedType: "BOOLEAN" }, value: true },
      { variable: { id: "VariableID:1:2", name: "level", resolvedType: "FLOAT" }, value: 0.5 },
      { variable: { id: "VariableID:1:3", name: "label", resolvedType: "STRING" }, value: "hello" },
      {
        variable: { id: "VariableID:1:4", name: "tint", resolvedType: "COLOR" },
        value: { r: 1, g: 0, b: 0, a: 0.5 },
      },
    ]);
  });

  test("creates the collection when the file has none", async () => {
    const { adapter, created } = figmaFile([], ["Brand"]);
    expect(await adapter.readSnapshot()).toEqual([]);
    expect(created).toEqual(["MHB"]);
  });

  test("leaves out a type the bridge cannot carry", async () => {
    expect(
      await values([
        { id: "VariableID:1:1", name: "ease", type: "EASING", value: "ease-in" },
        { id: "VariableID:1:2", name: "level", type: "FLOAT", value: 1 },
      ]),
    ).toEqual({ level: 1 });
  });

  test("follows an alias chain, each target in its own collection's default mode", async () => {
    expect(
      await values([
        { id: "VariableID:1:1", name: "level", type: "FLOAT", value: alias("VariableID:1:2") },
        { id: "VariableID:1:2", name: "middle", type: "FLOAT", value: alias("VariableID:9:9") },
        { id: "VariableID:9:9", name: "brand", type: "FLOAT", collection: "Brand", value: 7 },
      ]),
    ).toEqual({ level: 7, middle: 7 });
  });

  test("leaves out the variables of an alias cycle", async () => {
    expect(
      await values([
        { id: "VariableID:1:1", name: "a", type: "FLOAT", value: alias("VariableID:1:2") },
        { id: "VariableID:1:2", name: "b", type: "FLOAT", value: alias("VariableID:1:1") },
        { id: "VariableID:1:3", name: "self", type: "FLOAT", value: alias("VariableID:1:3") },
        { id: "VariableID:1:4", name: "level", type: "FLOAT", value: 1 },
      ]),
    ).toEqual({ level: 1 });
  });

  test("leaves out an alias to a variable or a collection that is gone", async () => {
    expect(
      await values([
        { id: "VariableID:1:1", name: "dangling", type: "FLOAT", value: alias("VariableID:7:7") },
        { id: "VariableID:1:2", name: "orphaned", type: "FLOAT", value: alias("VariableID:8:8") },
        { id: "VariableID:8:8", name: "lost", type: "FLOAT", collection: "Deleted", value: 3 },
      ]),
    ).toEqual({});
  });

  test("leaves out a value that does not fit the variable's type", async () => {
    expect(
      await values([
        { id: "VariableID:1:1", name: "level", type: "FLOAT", value: alias("VariableID:1:2") },
        { id: "VariableID:1:2", name: "label", type: "STRING", value: "abc" },
      ]),
    ).toEqual({ label: "abc" });
  });

  test("flattens a composed color: the opacity is a percentage and replaces the alpha", async () => {
    const red = { r: 1, g: 0, b: 0, a: 1 };
    expect(
      await values([
        { id: "VariableID:1:1", name: "plain", type: "COLOR", value: { color: red, opacity: 50 } },
        {
          id: "VariableID:1:2",
          name: "aliased",
          type: "COLOR",
          value: { color: alias("VariableID:1:4"), opacity: alias("VariableID:1:5") },
        },
        {
          id: "VariableID:1:3",
          name: "expression",
          type: "COLOR",
          value: {
            type: "VARIABLE_EXPRESSION",
            expressionFunction: "COMPOSE_COLOR",
            expressionArguments: [alias("VariableID:1:4"), 25],
          },
        },
        { id: "VariableID:1:4", name: "base", type: "COLOR", value: { ...red, a: 0.9 } },
        { id: "VariableID:1:5", name: "fade", type: "FLOAT", value: 20 },
      ]),
    ).toEqual({
      plain: { r: 1, g: 0, b: 0, a: 0.5 },
      aliased: { r: 1, g: 0, b: 0, a: 0.2 },
      expression: { r: 1, g: 0, b: 0, a: 0.25 },
      base: { r: 1, g: 0, b: 0, a: 0.9 },
      fade: 20,
    });
  });

  test("leaves out a composed color whose parts do not resolve", async () => {
    expect(
      await values([
        {
          id: "VariableID:1:1",
          name: "broken",
          type: "COLOR",
          value: { color: alias("VariableID:7:7"), opacity: 50 },
        },
        {
          id: "VariableID:1:2",
          name: "no opacity",
          type: "COLOR",
          value: { color: { r: 1, g: 0, b: 0, a: 1 }, opacity: "half" },
        },
      ]),
    ).toEqual({});
  });
});

describe("writing a value", () => {
  test("writes into the default mode of the variable's collection", async () => {
    const { adapter, variables } = figmaFile([
      { id: "VariableID:1:1", name: "level", type: "FLOAT", value: 0 },
      { id: "VariableID:1:2", name: "tint", type: "COLOR", value: { r: 0, g: 0, b: 0, a: 1 } },
    ]);

    expect(await adapter.writeValue("VariableID:1:1", 0.75)).toBeNull();
    expect(await adapter.writeValue("VariableID:1:2", { r: 1, g: 0.5, b: 0, a: 0.5 })).toBeNull();
    expect(variables.map((variable) => variable.value)).toEqual([
      0.75,
      { r: 1, g: 0.5, b: 0, a: 0.5 },
    ]);
  });

  test("says nothing about a variable that no longer exists", async () => {
    const { adapter } = figmaFile([]);
    expect(await adapter.writeValue("VariableID:7:7", 1)).toBeNull();
  });

  test("rejects a write Figma refuses, with a message for the user", async () => {
    const { adapter } = figmaFile([
      { id: "VariableID:1:1", name: "level", type: "FLOAT", value: 0, readOnly: true },
    ]);

    expect(await adapter.writeValue("VariableID:1:1", 0.75)).toEqual({
      message: "Could not set variable (level) to 0.75",
      cause: new Error("cannot set this variable"),
    });
  });
});
