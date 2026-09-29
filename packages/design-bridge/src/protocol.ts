/**
 * The design-tool bridge wire protocol: the MQTT topics a design-tool plugin
 * (Figma, Penpot) and Microflow Studio exchange.
 *
 * Every topic is `microflow/{uid}/{client}/…`, where `{client}` is the sender:
 * a design tool (`figma`, `penpot`) or Studio (`app`). The Rust side mirrors this
 * module in `crates/microflow-core/src/design_bridge.rs`; both are checked
 * against `fixtures/protocol.json`.
 */

export const DESIGN_TOOLS = ["figma", "penpot"] as const;
export type DesignTool = (typeof DESIGN_TOOLS)[number];

/** Studio's client segment. */
export const STUDIO = "app";

export type BridgeClient = DesignTool | typeof STUDIO;

export const RESOLVED_TYPES = ["BOOLEAN", "FLOAT", "STRING", "COLOR"] as const;
export type ResolvedType = (typeof RESOLVED_TYPES)[number];

/** A color with every channel in the 0–1 range. */
export type BridgeColor = { r: number; g: number; b: number; a: number };
export type BridgeValue = boolean | number | string | BridgeColor;

/** One entry of the retained `{tool}/variables` list. `id` is the tool's own ID. */
export type BridgeVariable = { id: string; name: string; resolvedType: ResolvedType };

/** The retained `{tool}/variables` payload, keyed by variable ID. */
export type BridgeVariableList = Record<string, BridgeVariable>;

const ROOT = "microflow";

export const topics = {
  /** `connected` / `disconnected`, retained. The plugin's last will. */
  status: (uid: string, client: BridgeClient) => `${ROOT}/${uid}/${client}/status`,
  /** The tool's variable list, retained. */
  variables: (uid: string, tool: DesignTool) => `${ROOT}/${uid}/${tool}/variables`,
  /** A variable's current value, published by `client`. */
  value: (uid: string, client: string, wireId: string) =>
    `${ROOT}/${uid}/${client}/variable/${wireId}`,
  /** Studio asks the owning tool to change a variable. */
  set: (uid: string, wireId: string, from: BridgeClient = STUDIO) =>
    `${ROOT}/${uid}/${from}/variable/${wireId}/set`,
  /** Studio asks every tool to send its list and current values. */
  request: (uid: string, from: BridgeClient = STUDIO) => `${ROOT}/${uid}/${from}/variables/request`,
  /** Legacy reply to a request. Studio reads the retained `{tool}/variables` instead. */
  response: (uid: string, to: string) => `${ROOT}/${uid}/${to}/variables/response`,
  anyStatus: (uid: string) => `${ROOT}/${uid}/+/status`,
  anySet: (uid: string) => `${ROOT}/${uid}/+/variable/+/set`,
  anyRequest: (uid: string) => `${ROOT}/${uid}/+/variables/request`,
} as const;

export type ParsedTopic =
  | { kind: "status" | "variables" | "request" | "response"; uid: string; client: string }
  | { kind: "value" | "set"; uid: string; client: string; wireId: string };

/** Classify a bridge topic, or `null` when the topic is not part of the protocol. */
export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split("/");
  const [root, uid, client, ...rest] = parts;
  if (root !== ROOT || !uid || !client) return null;

  const [a, b, c, ...extra] = rest;
  if (extra.length > 0) return null;
  if (a === "status" && b === undefined) return { kind: "status", uid, client };
  if (a === "variables" && b === undefined) return { kind: "variables", uid, client };
  if (a === "variables" && b === "request" && c === undefined) return { kind: "request", uid, client };
  if (a === "variables" && b === "response" && c === undefined) return { kind: "response", uid, client };
  if (a === "variable" && b && c === undefined) return { kind: "value", uid, client, wireId: b };
  if (a === "variable" && b && c === "set") return { kind: "set", uid, client, wireId: b };
  return null;
}

/**
 * The bridge uid a topic belongs to, or `undefined` for topics outside the
 * protocol. Studio announces itself only for uids that design-bridge
 * subscriptions use, never for an arbitrary `microflow/…` topic.
 */
export function bridgeUid(topic: string): string | undefined {
  return parseTopic(topic)?.uid;
}

/**
 * The topic-safe form of a variable ID.
 * Figma: `VariableID:1:2` → `1-2`. Penpot token IDs (uuids) are already safe.
 */
export function toWireId(id: string): string {
  return id.replace(/^VariableID:/, "").replace(/:/g, "-");
}

/** Reverse of {@link toWireId} for one tool. */
export function fromWireId(tool: DesignTool, wireId: string): string {
  switch (tool) {
    case "figma":
      return `VariableID:${wireId.replace(/-/g, ":")}`;
    case "penpot":
      return wireId;
  }
}

/** Whether `segment` can be used as one MQTT topic level. */
export function isTopicSafe(segment: string): boolean {
  return segment.length > 0 && !/[/+#\s]/.test(segment);
}
