// The browser cloud performer: the cloud half of the flow host, lifted out of the
// FlowReactor god-object (ADR-0009).
//
// Mirrors the desktop `CloudPerformer` (apps/web/src-tauri/src/runtime/host.rs):
// it performs the cloud `Effects` a turn records — `mqttPublish` and `llmGenerate`
// — and reconciles the runtime's subscriber wirings into live MQTT-over-WSS
// subscriptions (incl. the Figma handshake). Like its desktop twin it is
// **host-free**: it never touches the wasm runtime, the board connection, or any
// Zustand store directly. The two re-entry points back into the runtime (an LLM
// result, an inbound broker message) arrive as injected callbacks — the browser
// analog of the desktop's `ActorMsg::Inject` / `ActorMsg::Deliver` channel sends.
// That makes it unit-testable with a stub `MqttClientFactory`, a stubbed `fetch`,
// and fake resolvers — no broker, no runtime (see `cloud-performer.test.ts`).

import type { CloudRequest } from "@/runtime/effects-sink";
import type { LlmProviderConn } from "@/ai/llm-client";
import { LlmPerformer } from "@/ai/llm-performer";
import {
  BrokerConnections,
  defaultMqttClientFactory,
  type BrokerConn,
  type MqttClientFactory,
} from "./mqtt-client";
import {
  diffSubscriptions,
  subKey,
  uidBrokers,
  type ActiveSub,
} from "./mqtt-subscriptions";

/**
 * Host-supplied resolvers the performer needs to perform cloud requests (ADR-0009).
 * Keeps it decoupled from the Zustand stores: the board controller passes thin
 * lookups so the performer never imports app state directly.
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

/** Re-enter an LLM result on the issuing node's handle — the host's
 *  `FlowRuntime.injectEvent` path. Mirrors the desktop `ActorMsg::Inject`. */
export type ResultInjector = (source: string, handle: string, value: unknown) => void;
/** Route an inbound broker message to a subscribe node — the host's
 *  `FlowRuntime.deliverMessage` path. Mirrors the desktop `ActorMsg::Deliver`. */
export type InboundDeliver = (nodeId: string, topic: string, payload: Uint8Array) => void;

/** One Figma plugin-handshake publish (the core `FigmaPublish` serde shape). */
export type FigmaPublish = { brokerId: string; topic: string; payload: string; retain: boolean };
/** Compute the Figma connect/disconnect publishes for a uid-set change
 *  (`prev`/`next` are `uid -> brokerId`). The handshake *protocol* lives in core
 *  ([`figma_announce_actions`]); injected as the wasm binding so the performer
 *  stays host-free / unit-testable — the desktop host calls the same core fn. */
export type FigmaAnnounce = (
  prev: Record<string, string>,
  next: Record<string, string>,
) => FigmaPublish[];

/**
 * Performs the cloud half of a flow host (ADR-0009): the LLM/MQTT network I/O a
 * turn's `Effects` record, plus the subscription reconcile (incl. Figma
 * handshake). The browser twin of the desktop `CloudPerformer` in
 * `src-tauri/src/runtime/host.rs` — and like it, host-free: it owns the
 * {@link BrokerConnections}, the shared {@link LlmPerformer}, and the injected
 * {@link CloudDeps} resolvers, but reaches the runtime only through the two
 * injected callbacks ({@link ResultInjector} / {@link InboundDeliver}). No wasm
 * runtime, no board connection, no store — so it unit-tests directly.
 */
export class CloudPerformer {
  /** Per-broker MQTT-over-WSS connections + the live subscription set, reconciled
   *  on each `applyFlow` against the runtime's subscriber wirings. */
  private readonly brokers: BrokerConnections;
  /** The `llmGenerate` half — the same performer the desktop host holds
   *  (ADR-0021); only the result re-entry differs. */
  private readonly llm: LlmPerformer;
  private liveSubs = new Map<string, ActiveSub>();
  private disposed = false;

  constructor(
    private readonly cloud: CloudDeps | null,
    /** Re-enter an LLM result on the issuing node's handle (`injectEvent`). The
     *  reactor supplies the runtime + clock; mirrors `ActorMsg::Inject`. */
    private readonly resultInjector: ResultInjector,
    /** Route an inbound broker message to its subscribe node (`deliverMessage`);
     *  mirrors `ActorMsg::Deliver`. */
    private readonly deliverInbound: InboundDeliver,
    /** The Figma handshake policy — core's `figma_announce_actions`, supplied as
     *  the wasm binding so the performer never imports the runtime (a TS stub in
     *  tests). The desktop host calls the same core fn directly. */
    private readonly figmaAnnounce: FigmaAnnounce,
    /** Stubbed in tests; defaults to the real `mqtt.connect` wrapper. */
    factory: MqttClientFactory = defaultMqttClientFactory,
  ) {
    this.brokers = new BrokerConnections(factory);
    this.llm = new LlmPerformer(
      (providerId) => this.cloud?.resolveLlmProvider(providerId),
      (source, handle, value) => this.resultInjector(source, handle, value),
    );
  }

  /** Perform one recorded cloud request. The `llmGenerate` → `LlmPerformer`,
   *  `mqttPublish` → `publishMqtt` switch; `mqttPublish` covers both the Mqtt
   *  publish node and Figma set-value. */
  perform(request: CloudRequest): void {
    if (request.kind === "llmGenerate") {
      void this.llm.perform(request);
      return;
    }
    // Intercepted by the reactor's Midi/Audio performers before delegation
    // (host peripherals, not network calls) — mirrors the desktop actor.
    if (request.kind !== "mqttPublish") {
      console.warn(
        `[cloud-performer] ${request.kind} reached the CloudPerformer — handled by the reactor`,
      );
      return;
    }
    this.publishMqtt(request.brokerId, request.topic, request.payload, request.retain);
  }

  /** Reconcile an already-reconciled desired subscription set (the wasm binding
   *  returns one per topic) into WSS subscriptions: subscribe new/changed topics,
   *  unsubscribe gone ones, and run the Figma uid connect/disconnect lifecycle.
   *  Called by the reactor after every `applyFlow`. */
  reconcile(reconciled: ActiveSub[]): void {
    const desired = new Map<string, ActiveSub>(
      reconciled.map((sub) => [subKey(sub.brokerId, sub.topic), sub] as const),
    );
    const { subscribe, unsubscribe } = diffSubscriptions(desired, this.liveSubs);
    const previousUids = uidBrokers(this.liveSubs.values());

    for (const sub of unsubscribe) this.brokers.unsubscribe(sub.brokerId, sub.topic);
    for (const sub of subscribe) this.subscribeOne(sub);
    this.liveSubs = desired;

    // After subscribing, so the plugins' answers to the request are received.
    this.figmaLifecycle(previousUids, uidBrokers(desired.values()));
  }

  /** Tear down: abort in-flight LLM calls, end every broker connection, and drop
   *  the live subscription set. */
  dispose(): void {
    // Tell the plugins Studio is gone before the connections close.
    const liveUids = uidBrokers(this.liveSubs.values());
    if (liveUids.size > 0) this.figmaLifecycle(liveUids, new Map());
    this.disposed = true;
    this.llm.dispose();
    this.brokers.disposeAll();
    this.liveSubs.clear();
  }

  // --- Cloud: MQTT + Figma over WSS (ADR-0009 Phase 3) ------------------------

  private subscribeOne(sub: ActiveSub): void {
    const broker = this.cloud?.resolveBroker(sub.brokerId);
    if (!broker) {
      console.warn(`[cloud-performer] no broker '${sub.brokerId}' configured for ${sub.topic}`);
      return;
    }
    this.brokers.subscribe(broker, sub.topic, (topic, payload) => this.onInbound(sub, topic, payload));
  }

  /** Inbound broker message: routing kinds drive the flow via {@link InboundDeliver}
   *  (the runtime's `deliverMessage`); every message is also offered to the
   *  optional UI feed (the desktop emits the same "mqtt-message" for both — the
   *  Figma store filters by topic). */
  private onInbound(sub: ActiveSub, topic: string, payload: Uint8Array): void {
    if (this.disposed) return;
    if (sub.kind === "plain" || sub.kind === "topicAware") {
      this.deliverInbound(sub.nodeId, topic, payload);
      this.cloud?.onMqttMessage?.(topic, payload, sub.nodeId);
    } else {
      this.cloud?.onMqttMessage?.(topic, payload);
    }
  }

  /** Figma plugin handshake over MQTT, driven by the live-uid delta. The protocol
   *  — a vanished uid → `disconnected`; a newly appeared uid → `connected`
   *  (retained) + a variables request — lives in core (via the injected
   *  {@link FigmaAnnounce}, core's `figma_announce_actions`); here we only perform
   *  the returned publishes. The desktop `flow_update` calls the same core policy,
   *  so both hosts announce identically. */
  private figmaLifecycle(oldUids: Map<string, string>, newUids: Map<string, string>): void {
    const actions = this.figmaAnnounce(Object.fromEntries(oldUids), Object.fromEntries(newUids));
    for (const a of actions) this.publishText(a.brokerId, a.topic, a.payload, a.retain);
  }

  private publishMqtt(brokerId: string, topic: string, payload: number[], retain: boolean): void {
    const broker = this.cloud?.resolveBroker(brokerId);
    if (!broker) {
      console.warn(`[cloud-performer] no broker '${brokerId}' configured for publish to ${topic}`);
      return;
    }
    this.brokers.publish(broker, topic, Uint8Array.from(payload), retain);
  }

  private publishText(brokerId: string, topic: string, text: string, retain: boolean): void {
    const broker = this.cloud?.resolveBroker(brokerId);
    if (broker) this.brokers.publish(broker, topic, new TextEncoder().encode(text), retain);
  }
}
