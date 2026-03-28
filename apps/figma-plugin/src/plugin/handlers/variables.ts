import { messages, sendToUI } from "../../common/messages";

const COLLECTION_NAME = "MHB";

export async function getLocalVariables() {
  const collection = await getOrCreateCollection();
  const variables = (
    await Promise.all(
      collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)),
    )
  ).filter((v): v is Variable => v !== null);

  sendToUI(
    messages.getLocalVariables(
      variables.map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description,
        resolvedType: v.resolvedType,
        valuesByMode: v.valuesByMode,
      })),
    ),
  );
}

export async function setLocalVariable(id: string, value: unknown) {
  const variable = await figma.variables.getVariableByIdAsync(id);
  const collection = await getOrCreateCollection();
  if (!variable) return;

  const mapped = mapToFigmaValue(variable.resolvedType, value);
  if (mapped === null) {
    figma.notify(
      `Received invalid value (${String(value)}) for variable (${variable.name})`,
      { error: true },
    );
    return;
  }

  variable.setValueForMode(collection.defaultModeId, mapped);
}

export async function deleteVariable(id: string) {
  const variable = await figma.variables.getVariableByIdAsync(id);
  if (variable) variable.remove();
  sendToUI(messages.deleteVariable(id));
}

// ── Collection helper ───────────────────────────────────────────────

async function getOrCreateCollection() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  return (
    collections.find(({ name }) => name === COLLECTION_NAME) ??
    figma.variables.createVariableCollection(COLLECTION_NAME)
  );
}

// ── Value mapping ───────────────────────────────────────────────────

function mapToFigmaValue(
  type: VariableResolvedDataType,
  value: unknown,
): VariableValue | null {
  try {
    switch (type) {
      case "BOOLEAN":
        return toBooleanOrNull(value);
      case "FLOAT":
        return toFloatOrNull(value);
      case "STRING":
        return toStringOrNull(value);
      case "COLOR":
        return toRgbaOrNull(value);
    }
  } catch {
    return null;
  }
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string")
    return ["true", "yes", "1", "si", "on"].includes(value.toLowerCase());
  if (typeof value === "number") return value === 1;
  return null;
}

function toFloatOrNull(value: unknown): number | null {
  const str = String(value).replace(",", ".");
  const float = parseFloat(str);
  if (isNaN(float)) {
    const bool = toBooleanOrNull(str);
    return bool !== null ? Number(bool) : null;
  }
  const int = parseInt(str);
  if (isNaN(int)) return null;
  return float > int ? float : int;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  return null;
}

function toRgbaOrNull(value: unknown): RGBA | null {
  try {
    if (typeof value === "string") return figma.util.rgba(value);
    if (typeof value === "object" && value !== null)
      return figma.util.rgba(value as RGB | RGBA);
  } catch {
    // fall through
  }
  return null;
}
