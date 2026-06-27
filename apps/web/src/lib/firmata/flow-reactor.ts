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
//
// The cloud half (LLM/MQTT/Figma) lives in its own {@link CloudPerformer} — the
// browser twin of the desktop `CloudPerformer` (ADR-0009). The reactor stays the
// serial loop + `EffectsSink`: it delegates cloud requests + subscription
// reconcile to the performer, and wires the two runtime re-entry points (an LLM
// result, an inbound broker message) as callbacks the performer calls back into.

import { applyComponentEvent } from "@/lib/event-ingest";
import {
  createFlowRuntime,
  figmaAnnounceActions,
  type Effects,
  type FlowRuntime,
} from "@/lib/runtime/wasm";
import { CloudPerformer, type CloudDeps } from "./cloud/cloud-performer";
import type { ActiveSub } from "./cloud/mqtt-subscriptions";
import {
  applyEffects,
  type CloudRequest,
  type ComponentEvent,
  type EffectsSink,
  type Wakeup,
} from "./effects-sink";
import type { BoardConnection } from "./web-serial";

// Re-exported so the board controller keeps importing `CloudDeps` from here; the
// type now lives with the performer that consumes it.
export type { CloudDeps };

/** Edges as carried in the core `FlowUpdate` JSON (Rust camelCase). */
type CoreEdge = {
  id?: string | null;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
};

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
  /** The cloud half (LLM/MQTT/Figma), lifted out of this class (ADR-0009). The
   *  reactor supplies the two runtime re-entry seams the performer needs. */
  private readonly cloudPerformer: CloudPerformer;
  private edges: CoreEdge[] = [];
  private disposed = false;

  private constructor(
    private readonly connection: BoardConnection,
    cloud: CloudDeps | null,
  ) {
    this.cloudPerformer = new CloudPerformer(
      cloud,
      // LLM result re-entry: inject on the node's handle and apply the cascade it
      // drives (mirrors the desktop `ActorMsg::Inject` → `inject_event`).
      (source, handle, value) => {
        if (!this.runtime || this.disposed) return;
        this.apply(this.runtime.injectEvent(source, handle, JSON.stringify(value), now()));
      },
      // Inbound broker message re-entry: route to the subscribe node and apply
      // (mirrors the desktop `ActorMsg::Deliver` → `deliver_message`).
      (nodeId, topic, payload) => {
        if (!this.runtime || this.disposed) return;
        this.apply(this.runtime.deliverMessage(nodeId, topic, payload, now()));
      },
      // Figma handshake policy: core's `figma_announce_actions` via the wasm
      // binding, so the browser announces identically to the desktop host.
      figmaAnnounceActions,
    );
  }

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
    this.reconcile();
  }

  /** Feed raw inbound serial bytes (from the Web Serial read loop). */
  feedBytes(bytes: Uint8Array): void {
    if (!this.runtime || this.disposed) return;
    this.apply(this.runtime.feedBytes(bytes, now()));
  }

  /** Tear down: cancel every pending timer, tear down the cloud performer (abort
   *  in-flight cloud calls + end broker connections), and drop the runtime. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.cloudPerformer.dispose();
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

  /** Reconcile the runtime's subscriber wirings into the cloud performer's live
   *  WSS subscriptions after every `applyFlow`. The collapse + winner-selection is
   *  core policy (`reconcile_desired`); the wasm binding hands back an
   *  already-reconciled desired set (one per topic), which the performer diffs
   *  against its live set. */
  private reconcile(): void {
    if (!this.runtime || this.disposed) return;
    let reconciled: ActiveSub[];
    try {
      reconciled = JSON.parse(this.runtime.reconcileSubscriptions()) as ActiveSub[];
    } catch (error) {
      console.error("[flow-reactor] bad reconcileSubscriptions json:", error);
      return;
    }
    this.cloudPerformer.reconcile(reconciled);
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

  /** Perform a cloud node's outbound call (ADR-0009) by delegating to the
   *  {@link CloudPerformer}, which owns the MQTT/LLM services + the in-flight LLM
   *  task table. The ordering (cloud before UI events) is fixed by
   *  {@link applyEffects}; this just supplies the primitive. */
  performCloud(request: CloudRequest): void {
    this.cloudPerformer.perform(request);
  }

  dispatchEvent(event: ComponentEvent): void {
    applyComponentEvent(event, this.edges);
  }
}
