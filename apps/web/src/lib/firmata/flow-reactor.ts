// The browser flow reactor: the host loop around the wasm `FlowRuntime`.
//
// The desktop runs the flow engine on a background thread and emits
// `component-event`s over Tauri IPC (see hooks/use-component-events.ts). In the
// browser the same engine runs in wasm (microflow-runtime-wasm) and THIS module
// is its host: it owns the board connection + the wasm runtime, feeds inbound
// Web Serial bytes in, writes the runtime's outbound bytes back, arms/cancels
// `setTimeout`s for the runtime's timer wakeups, and pushes emitted component
// events into the very same UI stores the desktop path feeds. So the canvas
// (node values + edge signals) renders identically on both platforms.

import type { EmitOf } from "@/components/flow/nodes/_base/_base.types";
import { applyComponentEvent } from "@/lib/event-ingest";
import { createFlowRuntime, type Effects, type FlowRuntime } from "@/lib/runtime/wasm";
import { performLlmGenerate, type LlmProviderConn } from "./cloud/llm-client";
import { BrokerConnections, type BrokerConn } from "./cloud/mqtt-client";
import {
  diffSubscriptions,
  subKey,
  uidBrokers,
  type ActiveSub,
} from "./cloud/mqtt-subscriptions";
import {
  applyEffects,
  type CloudRequest,
  type ComponentEvent,
  type EffectsSink,
  type Wakeup,
} from "./effects-sink";
import type { BoardConnection } from "./web-serial";

/** Edges as carried in the core `FlowUpdate` JSON (Rust camelCase). */
type CoreEdge = {
  id?: string | null;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
};

/**
 * Host-supplied resolvers the reactor needs to perform cloud requests (ADR-0009).
 * Keeps the reactor decoupled from the Zustand stores: the board controller
 * passes thin lookups so the reactor never imports app state directly.
 */
export type CloudDeps = {
  /** Resolve a `providerId` (from an `llmGenerate` request) to its connection. */
  resolveLlmProvider: (providerId: string) => LlmProviderConn | undefined;
  /** Resolve a `brokerId` (from an `mqttPublish` request or subscriber wiring) to
   *  its WSS connection. */
  resolveBroker: (brokerId: string) => BrokerConn | undefined;
  /** Optional UI feed for inbound broker messages (e.g. the Figma store),
   *  mirroring the desktop "mqtt-message" event. `nodeId` is set for routed
   *  (plain/topicAware) messages, omitted for display-echo. */
  onMqttMessage?: (topic: string, payload: Uint8Array, nodeId?: string) => void;
};

// The `Llm` node's output handles, typed against the catalog's `Llm` emits
// (ADR-0007). `EmitOf<"Llm">` is the literal union the codegen derives from
// node-components.json — the SAME source the Catalog Parity Guard pins the Rust
// `Llm::emits()` / `Llm::E_*` consts to. Annotating each const with it means a
// renamed/removed handle in the catalog makes these assignments fail to compile,
// closing the gap where the browser hard-coded a string the desktop sourced from
// a Rust const. The browser host injects results on exactly these handles,
// mirroring the desktop `CloudPerformer`.
const LLM_THINKING: EmitOf<"Llm"> = "thinking";
const LLM_VALUE: EmitOf<"Llm"> = "value";
const LLM_DONE: EmitOf<"Llm"> = "done";
const LLM_ERROR: EmitOf<"Llm"> = "error";

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * Drives a wasm `FlowRuntime` for one connected board. Create with
 * {@link FlowReactor.attach} after a board is up; feed it the live flow via
 * {@link applyFlow} and raw bytes via {@link feedBytes}; {@link dispose} on
 * teardown.
 */
export class FlowReactor implements EffectsSink {
  private runtime: FlowRuntime | null = null;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** In-flight LLM generations keyed by issuing node id (latest-wins: a fresh
   *  trigger aborts its predecessor, mirroring the desktop `CloudPerformer`). */
  private readonly llmAborts = new Map<string, AbortController>();
  /** Per-broker MQTT-over-WSS connections + the live subscription set, reconciled
   *  on each `applyFlow` against the runtime's subscriber wirings. */
  private readonly brokers = new BrokerConnections();
  private liveSubs = new Map<string, ActiveSub>();
  private edges: CoreEdge[] = [];
  private disposed = false;

  private constructor(
    private readonly connection: BoardConnection,
    private readonly cloud: CloudDeps | null,
  ) {}

  /** Instantiate the wasm runtime and seed its pin table from the detection
   *  session's discovered capabilities (so inbound decode + analog math work).
   *  `cloud` supplies the provider/broker lookups cloud nodes need; omit it and
   *  cloud requests are logged and skipped. */
  static async attach(connection: BoardConnection, cloud?: CloudDeps): Promise<FlowReactor> {
    const reactor = new FlowReactor(connection, cloud ?? null);
    const runtime = await createFlowRuntime();
    try {
      runtime.setPins(connection.session.pinsJson());
    } catch (error) {
      console.warn("[flow-reactor] setPins failed (continuing without seed):", error);
    }
    reactor.runtime = runtime;
    return reactor;
  }

  /** Apply a flow graph. `flowJson` is the core `FlowUpdate` shape (`{nodes, edges}`). */
  applyFlow(flowJson: string): void {
    if (!this.runtime || this.disposed) return;
    try {
      this.edges = (JSON.parse(flowJson) as { edges?: CoreEdge[] }).edges ?? [];
    } catch {
      this.edges = [];
    }
    this.apply(this.runtime.updateFlow(flowJson, now()));
    this.reconcileSubscriptions();
  }

  /** Feed raw inbound serial bytes (from the Web Serial read loop). */
  feedBytes(bytes: Uint8Array): void {
    if (!this.runtime || this.disposed) return;
    this.apply(this.runtime.feedBytes(bytes, now()));
  }

  /** Tear down: cancel every pending timer, abort in-flight cloud calls, and
   *  drop the runtime. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    for (const controller of this.llmAborts.values()) controller.abort();
    this.llmAborts.clear();
    this.brokers.disposeAll();
    this.liveSubs.clear();
    this.runtime = null;
  }

  /** Apply one turn's effects in the canonical order (ADR-0008). The order
   *  lives in {@link applyEffects} (mirroring the Rust `Effects::apply`); this
   *  reactor is the `EffectsSink` supplying the four browser primitives below. */
  private apply(effectsJson: string): void {
    if (this.disposed) return;
    let fx: Effects;
    try {
      fx = JSON.parse(effectsJson) as Effects;
    } catch (error) {
      console.error("[flow-reactor] bad effects json:", error);
      return;
    }
    applyEffects(fx, this);
  }

  // --- EffectsSink: the browser platform primitives (ADR-0008) ---------------

  writeBytes(bytes: number[]): void {
    void this.connection.write(Uint8Array.from(bytes)).catch((error: unknown) => {
      console.warn("[flow-reactor] write failed:", error);
    });
  }

  cancelWakeup(id: number): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(id);
    }
  }

  armWakeup(wakeup: Wakeup): void {
    const handle = setTimeout(() => {
      this.timers.delete(wakeup.id);
      if (!this.runtime || this.disposed) return;
      this.apply(this.runtime.wake(wakeup.nodeId, wakeup.method, now()));
    }, wakeup.delayMs);
    this.timers.set(wakeup.id, handle);
  }

  performCloud(request: CloudRequest): void {
    if (request.kind === "llmGenerate") {
      void this.runLlm(request);
      return;
    }
    // mqttPublish covers both the Mqtt publish node and Figma set-value.
    this.publishMqtt(request.brokerId, request.topic, request.payload, request.retain);
  }

  dispatchEvent(event: ComponentEvent): void {
    applyComponentEvent(event, this.edges);
  }

  // --- Cloud: LLM generation (ADR-0009 Phase 3) -------------------------------

  /** Perform an `llmGenerate` request and re-enter the result on the `Llm`
   *  node's handles, mirroring the desktop `CloudPerformer`: `thinking = true`
   *  was already emitted synchronously by the node's dispatch; here we resolve
   *  the provider, POST, and inject `thinking = false` + `value`/`done` (or
   *  `error`). Latest-wins: a re-trigger for the same node aborts this one. */
  private async runLlm(request: Extract<CloudRequest, { kind: "llmGenerate" }>): Promise<void> {
    const { source } = request;
    const provider = this.cloud?.resolveLlmProvider(request.providerId);
    if (!provider) {
      this.injectLlmError(source, `LLM provider '${request.providerId}' not configured`);
      return;
    }

    this.llmAborts.get(source)?.abort();
    const controller = new AbortController();
    this.llmAborts.set(source, controller);

    try {
      const text = await performLlmGenerate(
        provider,
        { model: request.model, system: request.system, prompt: request.prompt },
        controller.signal,
      );
      if (controller.signal.aborted || this.disposed) return;
      this.inject(source, LLM_THINKING, false);
      this.inject(source, LLM_VALUE, text);
      this.inject(source, LLM_DONE, true);
    } catch (error) {
      // A superseded (aborted) or torn-down generation drops silently — its
      // result would route nowhere (mirrors the desktop `LlmError::Cancelled`).
      if (controller.signal.aborted || this.disposed) return;
      this.injectLlmError(source, error instanceof Error ? error.message : String(error));
    } finally {
      if (this.llmAborts.get(source) === controller) this.llmAborts.delete(source);
    }
  }

  private injectLlmError(source: string, message: string): void {
    this.inject(source, LLM_THINKING, false);
    this.inject(source, LLM_ERROR, message);
  }

  /** Inject one cloud result value on `handle` and apply the cascade it drives.
   *  `value` is a `ComponentValue` — a bare boolean/string serializes to the
   *  untagged JSON the runtime parses. */
  private inject(source: string, handle: string, value: boolean | string): void {
    if (!this.runtime || this.disposed) return;
    this.apply(this.runtime.injectEvent(source, handle, JSON.stringify(value), now()));
  }

  // --- Cloud: MQTT + Figma over WSS (ADR-0009 Phase 3) ------------------------

  /** Reconcile the runtime's subscriber wirings into WSS subscriptions (mirrors
   *  the desktop `flow_update` reconcile): subscribe new/changed topics,
   *  unsubscribe gone ones, and run the Figma uid connect/disconnect lifecycle.
   *  Called after every `applyFlow`. */
  private reconcileSubscriptions(): void {
    if (!this.runtime || this.disposed) return;
    // The collapse + winner-selection is core policy (`reconcile_desired`); the
    // wasm binding hands back an already-reconciled desired set, one per topic.
    let reconciled: ActiveSub[];
    try {
      reconciled = JSON.parse(this.runtime.reconcileSubscriptions()) as ActiveSub[];
    } catch (error) {
      console.error("[flow-reactor] bad reconcileSubscriptions json:", error);
      return;
    }

    const desired = new Map<string, ActiveSub>(
      reconciled.map((sub) => [subKey(sub.brokerId, sub.topic), sub] as const),
    );
    const { subscribe, unsubscribe } = diffSubscriptions(desired, this.liveSubs);

    this.figmaLifecycle(uidBrokers(this.liveSubs.values()), uidBrokers(desired.values()));

    for (const sub of unsubscribe) this.brokers.unsubscribe(sub.brokerId, sub.topic);
    for (const sub of subscribe) this.subscribeOne(sub);
    this.liveSubs = desired;
  }

  private subscribeOne(sub: ActiveSub): void {
    const broker = this.cloud?.resolveBroker(sub.brokerId);
    if (!broker) {
      console.warn(`[flow-reactor] no broker '${sub.brokerId}' configured for ${sub.topic}`);
      return;
    }
    this.brokers.subscribe(broker, sub.topic, (topic, payload) => this.onInbound(sub, topic, payload));
  }

  /** Inbound broker message: routing kinds drive the flow via `deliverMessage`;
   *  every message is also offered to the optional UI feed (the desktop emits the
   *  same "mqtt-message" for both — the Figma store filters by topic). */
  private onInbound(sub: ActiveSub, topic: string, payload: Uint8Array): void {
    if (!this.runtime || this.disposed) return;
    if (sub.kind === "plain" || sub.kind === "topicAware") {
      this.apply(this.runtime.deliverMessage(sub.nodeId, topic, payload, now()));
      this.cloud?.onMqttMessage?.(topic, payload, sub.nodeId);
    } else {
      this.cloud?.onMqttMessage?.(topic, payload);
    }
  }

  /** Figma plugin handshake over MQTT: a uid that just appeared announces
   *  `connected` (retained) + requests its current variable values; a vanished
   *  uid publishes `disconnected`. Mirrors the desktop `flow_update` tail. */
  private figmaLifecycle(oldUids: Map<string, string>, newUids: Map<string, string>): void {
    for (const [uid, brokerId] of oldUids) {
      if (!newUids.has(uid)) {
        this.publishText(brokerId, `microflow/${uid}/app/status`, "disconnected", true);
      }
    }
    for (const [uid, brokerId] of newUids) {
      if (oldUids.has(uid)) continue;
      this.publishText(brokerId, `microflow/${uid}/app/status`, "connected", true);
      this.publishText(brokerId, `microflow/${uid}/app/variables/request`, "", false);
    }
  }

  private publishMqtt(brokerId: string, topic: string, payload: number[], retain: boolean): void {
    const broker = this.cloud?.resolveBroker(brokerId);
    if (!broker) {
      console.warn(`[flow-reactor] no broker '${brokerId}' configured for publish to ${topic}`);
      return;
    }
    this.brokers.publish(broker, topic, Uint8Array.from(payload), retain);
  }

  private publishText(brokerId: string, topic: string, text: string, retain: boolean): void {
    const broker = this.cloud?.resolveBroker(brokerId);
    if (broker) this.brokers.publish(broker, topic, new TextEncoder().encode(text), retain);
  }
}
