import { CreateVariable, DeleteVariable, GetLocalVariables, MESSAGE_TYPE } from "../../common/types/Message";

const FIGMA_PLUGIN_NAME = 'FHB'

export async function deleteVariable(id: string) {
  const variable = await figma.variables.getVariableByIdAsync(id);

  if (variable) {
    variable.remove();
  }

  figma.ui.postMessage(DeleteVariable(id));
}

export async function createVariable(
  name: string,
  resolvedType: VariableResolvedDataType,
) {
  const collection = await getCollection();

  figma.variables.createVariable(name, collection, resolvedType);
  figma.ui.postMessage(CreateVariable({ name, resolvedType }));
}

export async function getLocalVariables(type: MESSAGE_TYPE.GET_LOCAL_VARIABLES | MESSAGE_TYPE.MQTT_GET_LOCAL_VARIABLES) {
  const collection = await getCollection();

  const promises = collection.variableIds.map((id) =>
    figma.variables.getVariableByIdAsync(id),
  );
  const variables = (await Promise.all(promises)).filter(Boolean);

  const variablesToSend = variables.map((variable) => {
    return {
      id: variable.id,
      name: variable.name,
      description: variable.description,
      resolvedType: variable.resolvedType,
      valuesByMode: variable.valuesByMode,
    };
  });
  figma.ui.postMessage(GetLocalVariables(variablesToSend, type));
}

export async function setLocalvariable(id: string, value: unknown) {
  const variable = await figma.variables.getVariableByIdAsync(id);
  const collection = await getCollection();

  if (!variable) return;

  const newValue = mapValueToFigmaValue(variable.resolvedType, value);

  if (newValue === null) {
    figma.notify(
      `Received invalid value (${value as string}) for variable (${variable.name})`,
      { error: true },
    );
    return;
  }

  variable.setValueForMode(collection.defaultModeId, newValue);
}

async function getCollection() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collection = collections.find(
    ({ name }) => name === FIGMA_PLUGIN_NAME,
  );
  if (!collection) {
    return figma.variables.createVariableCollection(FIGMA_PLUGIN_NAME);
  }
  return collection;
}

function unknownToBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    return ["true", "yes", "1", "si", "on"].includes(value.toLowerCase());
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  return null;
}

function unknownToFloatOrNull(value: unknown): number | null {
  const formattedString = String(value).replace(',', ".");
  const float = parseFloat(formattedString);

  if (isNaN(float)) {
    const booleanValue = unknownToBooleanOrNull(formattedString);
    if (booleanValue !== null) {
      return Number(booleanValue);
    }
    return null;
  }

  const number = parseInt(formattedString);
  if (isNaN(number)) return null;

  return float > number ? float : number;
}

function unknownToStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;

  return null;
}

function unknownToRgbaOrNull(value: unknown) {
  if (typeof value === "string") {
    try {
      return figma.util.rgba(value);
    } catch (error) {
      console.log({ error });
    }
  }

  return null;
}

export function mapValueToFigmaValue(
  type: VariableResolvedDataType,
  value: unknown,
): VariableValue | null {
  try {
    switch (type) {
      case "BOOLEAN":
        return unknownToBooleanOrNull(value);
      case "COLOR":
        return unknownToRgbaOrNull(value)
      case "FLOAT":
        return unknownToFloatOrNull(value);
      case "STRING":
        return unknownToStringOrNull(value);
    }
  } catch (error) {
    console.log("unable to map value", { error })
    return null
  }
}
