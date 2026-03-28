export const shortVarId = (id: string) => id.replace("VariableID:", "").replace(/:/g, "-");
export const fullVarId = (short: string) => `VariableID:${short.replace(/-/g, ":")}`;
