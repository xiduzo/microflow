/**
 * Figma's side of the design bridge: the variables of the "MHB" collection,
 * read as bridge variables in their collection's default mode and written back
 * from bridge values.
 */
import {
  type BridgeSnapshotEntry,
  type ResolvedType,
  type SandboxAdapter,
  RESOLVED_TYPES,
  coerce,
  toColor,
} from "@microflow/design-bridge";

export const COLLECTION_NAME = "MHB";

type BridgeCollection = Pick<VariableCollection, "name" | "variableIds" | "defaultModeId">;
type BridgeSource = Pick<
  Variable,
  "name" | "resolvedType" | "valuesByMode" | "variableCollectionId" | "setValueForMode"
>;

/** The part of `figma.variables` the adapter uses. Tests pass a stand-in. */
export type FigmaVariables = {
  getLocalVariableCollectionsAsync(): Promise<BridgeCollection[]>;
  createVariableCollection(name: string): BridgeCollection;
  getVariableByIdAsync(id: string): Promise<BridgeSource | null>;
  getVariableCollectionByIdAsync(id: string): Promise<BridgeCollection | null>;
};

export function createFigmaAdapter(variables: FigmaVariables): SandboxAdapter {
  /** A variable's value in its own collection's default mode; `undefined` when it is gone. */
  async function defaultValue(id: string): Promise<unknown> {
    const variable = await variables.getVariableByIdAsync(id);
    if (!variable) return undefined;
    const collection = await variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    return collection ? variable.valuesByMode[collection.defaultModeId] : undefined;
  }

  return {
    async readSnapshot() {
      const collections = await variables.getLocalVariableCollectionsAsync();
      const collection =
        collections.find(({ name }) => name === COLLECTION_NAME) ??
        variables.createVariableCollection(COLLECTION_NAME);

      const entries = await Promise.all(
        collection.variableIds.map(async (id): Promise<BridgeSnapshotEntry | null> => {
          const variable = await variables.getVariableByIdAsync(id);
          if (!variable || !isBridgeType(variable.resolvedType)) return null;
          const { resolvedType } = variable;
          const own = variable.valuesByMode[collection.defaultModeId];
          const value = coerce(resolvedType, await resolve(own, defaultValue, new Set([id])));
          if (value === null) return null;
          return { variable: { id, name: variable.name, resolvedType }, value };
        }),
      );
      return entries.filter((entry) => entry !== null);
    },

    async writeValue(id, value) {
      const variable = await variables.getVariableByIdAsync(id);
      if (!variable) return null;
      const collection = await variables.getVariableCollectionByIdAsync(
        variable.variableCollectionId,
      );
      if (!collection) return null;

      const figmaValue: VariableValue =
        typeof value === "object" ? { r: value.r, g: value.g, b: value.b, a: value.a } : value;
      try {
        variable.setValueForMode(collection.defaultModeId, figmaValue);
        return null;
      } catch (cause) {
        return {
          message: `Could not set variable (${variable.name}) to ${JSON.stringify(value)}`,
          cause,
        };
      }
    },
  };
}

function isBridgeType(type: VariableResolvedDataType): type is ResolvedType {
  return (RESOLVED_TYPES as readonly string[]).includes(type);
}

/**
 * Follow aliases and flatten composed colors. `lookup` gives an alias target's
 * value; `seen` holds the variables already on this alias chain, so a cycle
 * ends in `null` instead of a loop.
 */
async function resolve(
  value: unknown,
  lookup: (variableId: string) => Promise<unknown>,
  seen: Set<string>,
): Promise<unknown> {
  if (isAlias(value)) {
    if (seen.has(value.id)) return null;
    const target = await lookup(value.id);
    if (target === undefined) return null;
    return resolve(target, lookup, new Set(seen).add(value.id));
  }

  const composed = composedColor(value);
  if (composed) {
    const color = toColor(await resolve(composed.color, lookup, seen));
    const opacity = await resolve(composed.opacity, lookup, seen);
    if (!color || typeof opacity !== "number") return null;
    // The opacity is a percentage, and it replaces the color's own alpha.
    return { ...color, a: opacity / 100 };
  }

  return value;
}

function isAlias(value: unknown): value is VariableAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "VARIABLE_ALIAS" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/**
 * The typings declare a composed color as `{ color, opacity }`; some editor
 * versions return it as a `COMPOSE_COLOR` expression with the same two arguments.
 */
function composedColor(value: unknown): { color: unknown; opacity: unknown } | null {
  if (typeof value !== "object" || value === null) return null;
  if ("color" in value && "opacity" in value) return value;
  const expression = value as {
    type?: unknown;
    expressionFunction?: unknown;
    expressionArguments?: unknown;
  };
  if (
    expression.type === "VARIABLE_EXPRESSION" &&
    expression.expressionFunction === "COMPOSE_COLOR" &&
    Array.isArray(expression.expressionArguments)
  ) {
    const [color, opacity] = expression.expressionArguments as unknown[];
    return { color, opacity };
  }
  return null;
}
