import {
  type BridgeSnapshotEntry,
  type BridgeValue,
  type ResolvedType,
  RESOLVED_TYPES,
  coerce,
  toColor,
} from "@microflow/design-bridge";

const COLLECTION_NAME = "MHB";

/** The MHB variables and their default-mode values. Variables the bridge cannot carry are left out. */
export async function readSnapshot(): Promise<BridgeSnapshotEntry[]> {
  const collection = await getOrCreateCollection();
  const entries = await Promise.all(
    collection.variableIds.map(async (id): Promise<BridgeSnapshotEntry | null> => {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable || !isBridgeType(variable.resolvedType)) return null;
      const { resolvedType } = variable;
      const raw = await resolve(variable.valuesByMode[collection.defaultModeId], new Set([id]));
      const value = coerce(resolvedType, raw);
      if (value === null) return null;
      return { variable: { id, name: variable.name, resolvedType }, value };
    }),
  );
  return entries.filter((entry) => entry !== null);
}

export async function writeVariable(id: string, value: BridgeValue) {
  const variable = await figma.variables.getVariableByIdAsync(id);
  if (!variable) return;
  const collection = await figma.variables.getVariableCollectionByIdAsync(
    variable.variableCollectionId,
  );
  if (!collection) return;

  const figmaValue: VariableValue =
    typeof value === "object" ? { r: value.r, g: value.g, b: value.b, a: value.a } : value;
  try {
    variable.setValueForMode(collection.defaultModeId, figmaValue);
  } catch (error) {
    console.error(`[plugin] setting ${variable.name} failed`, error);
    figma.notify(`Could not set variable (${variable.name}) to ${JSON.stringify(value)}`, {
      error: true,
    });
  }
}

async function getOrCreateCollection() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  return (
    collections.find(({ name }) => name === COLLECTION_NAME) ??
    figma.variables.createVariableCollection(COLLECTION_NAME)
  );
}

function isBridgeType(type: VariableResolvedDataType): type is ResolvedType {
  return (RESOLVED_TYPES as readonly string[]).includes(type);
}

/**
 * Follow aliases (each target in its own collection's default mode) and flatten
 * composed colors. `seen` holds the variables already on this alias chain.
 */
async function resolve(value: unknown, seen: Set<string>): Promise<unknown> {
  if (isAlias(value)) {
    if (seen.has(value.id)) return null;
    const target = await figma.variables.getVariableByIdAsync(value.id);
    if (!target) return null;
    const collection = await figma.variables.getVariableCollectionByIdAsync(
      target.variableCollectionId,
    );
    if (!collection) return null;
    return resolve(target.valuesByMode[collection.defaultModeId], new Set(seen).add(value.id));
  }

  const composed = composedColor(value);
  if (composed) {
    const color = toColor(await resolve(composed.color, seen));
    const opacity = await resolve(composed.opacity, seen);
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
