/**
 * The plugin side of the bridge: publishes a design tool's variables and their
 * values, and applies the values Studio sets. Framework-free; each plugin feeds
 * it snapshots from its sandbox and gives it a `write` callback.
 */
import { coerce, decodePayload, encodeValue } from "./codec";
import {
  type BridgeValue,
  type BridgeVariable,
  type BridgeVariableList,
  type DesignTool,
  parseTopic,
  toWireId,
  topics,
} from "./protocol";

/** The MQTT operations the bridge needs. `@microflow/mqtt`'s store fits after a small adapter. */
export interface BridgeMqtt {
  publish(topic: string, payload: string, options?: { retain?: boolean }): void;
  subscribe(topic: string, onMessage: (topic: string, payload: string) => void): () => void;
}

/** One variable and its current value, as read from the design tool. */
export type BridgeSnapshotEntry = { variable: BridgeVariable; value: BridgeValue };

export type DesignBridgeOptions = {
  tool: DesignTool;
  uid: string;
  mqtt: BridgeMqtt;
  /** Write a value into the design tool. It is already coerced to the variable's type. */
  write: (variableId: string, value: BridgeValue) => void;
  /** An incoming value did not fit the variable's type and was dropped. */
  onInvalid?: (variable: BridgeVariable, payload: string) => void;
};

export class DesignBridge {
  private readonly variables = new Map<string, BridgeVariable>();
  private readonly byWireId = new Map<string, string>();
  /** Encoded value last published (or written) per variable ID. */
  private readonly published = new Map<string, string>();
  private publishedList: string | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly options: DesignBridgeOptions) {}

  start(): void {
    this.stop();
    const { uid, mqtt } = this.options;
    this.unsubscribers = [
      mqtt.subscribe(topics.anySet(uid), (topic, payload) => this.onSet(topic, payload)),
      mqtt.subscribe(topics.anyRequest(uid), (topic) => this.onRequest(topic)),
    ];
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }

  /** Forget what was published, so the next {@link update} publishes everything again. */
  reset(): void {
    this.published.clear();
    this.publishedList = null;
  }

  /** Feed the latest snapshot from the design tool; publishes only what changed. */
  update(entries: BridgeSnapshotEntry[]): void {
    const { tool, uid, mqtt } = this.options;

    this.variables.clear();
    this.byWireId.clear();
    const list: BridgeVariableList = {};
    for (const { variable } of entries) {
      this.variables.set(variable.id, variable);
      this.byWireId.set(toWireId(variable.id), variable.id);
      list[variable.id] = variable;
    }

    const listJson = JSON.stringify(list);
    if (listJson !== this.publishedList) {
      mqtt.publish(topics.variables(uid, tool), listJson, { retain: true });
      this.publishedList = listJson;
    }

    for (const id of this.published.keys()) {
      if (!this.variables.has(id)) this.published.delete(id);
    }
    for (const { variable, value } of entries) {
      const encoded = encodeValue(value);
      if (this.published.get(variable.id) === encoded) continue;
      mqtt.publish(topics.value(uid, tool, toWireId(variable.id)), encoded);
      this.published.set(variable.id, encoded);
    }
  }

  private onSet(topic: string, payload: string): void {
    const parsed = parseTopic(topic);
    if (parsed?.kind !== "set") return;
    const id = this.byWireId.get(parsed.wireId);
    // Not ours: the ID belongs to another design tool, or the variable is gone.
    const variable = id === undefined ? undefined : this.variables.get(id);
    if (!variable) return;

    const value = coerce(variable.resolvedType, decodePayload(payload));
    if (value === null) {
      this.options.onInvalid?.(variable, payload);
      return;
    }
    // Record it as published first, so the next snapshot does not echo it back.
    this.published.set(variable.id, encodeValue(value));
    this.options.write(variable.id, value);
  }

  private onRequest(topic: string): void {
    const parsed = parseTopic(topic);
    const { tool, uid, mqtt } = this.options;
    if (parsed?.kind !== "request" || parsed.client === tool) return;

    if (this.publishedList !== null) {
      mqtt.publish(topics.response(uid, parsed.client), this.publishedList);
    }
    for (const [id, encoded] of this.published) {
      mqtt.publish(topics.value(uid, parsed.client, toWireId(id)), encoded);
    }
  }
}
