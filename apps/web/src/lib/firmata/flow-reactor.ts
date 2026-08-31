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

import type { FlowEdge } from "@/lib/bindings/FlowEdge";
import type { FlowUpdate as FlowUpdateShape } from "@/lib/bindings/FlowUpdate";
import { applyComponentEvent } from "@/lib/event-ingest";
import { createFlowRuntime, figmaAnnounceActions, type Effects } from "@/lib/runtime/wasm";
import {
  RuntimeBridge,
  type FlowRuntimeCalls,
  type RuntimeFault,
} from "./runtime-bridge";
import { CloudPerformer, type CloudDeps } from "./cloud/cloud-performer";
import type { ActiveSub } from "./cloud/mqtt-subscriptions";
import { MidiPerformer } from "./midi/midi-performer";
import type { MidiListener } from "@/lib/runtime/wasm";
import {
  applyEffects,
  type CloudRequest,
  type ComponentEvent,
  type EffectsSink,
  type NodeDiagnostic,
  type Wakeup,
} from "./effects-sink";
import { useNodeDiagnosticsStore } from "@/stores/node-diagnostics";
import type { BoardConnection } from "./web-serial";

// Re-exported so the board controller keeps importing `CloudDeps` from here; the
// type now lives with the performer that consumes it.
export type { CloudDeps };

/** Optional wiring for {@link FlowReactor.attach}. */
export type AttachOptions = {
  /** Called once when the wasm engine dies (a Rust panic traps the module). The
   *  board is still connected at the transport level, but no flow will run
   *  again on this runtime — the host surfaces it and stops. */
  onEngineFault?: (message: string) => void;
  /** Use this runtime instead of loading the wasm module. The injection seam
   *  the fault tests drive; production leaves it unset. */
  runtime?: FlowRuntimeCalls;
};

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * A reply the runtime returned but the host could not decode. The call itself
 * succeeded, so the module is intact — this is `badInput` in the {@link
 * RuntimeFault} taxonomy, and it belongs to no single node. Routed through
 * {@link FlowReactor.handleFault} so a bad reply and a thrown fault reach the
 * same surface (ADR-0017), rather than one going to the seam and the other to
 * the console.
 */
const decodeFault = (op: string, error: unknown): RuntimeFault => ({
  kind: "badInput",
  op,
  node: null,
  message: `undecodable ${op} reply: ${error instanceof Error ? error.message : String(error)}`,
});

/**
 * Drives a wasm `FlowRuntime` for one connected board. Create with
 * {@link FlowReactor.attach} after a board is up; feed it the live flow via
 * {@link applyFlow} and raw bytes via {@link feedBytes}; {@link dispose} on
 * teardown.
 */
export class FlowReactor implements EffectsSink {
  /** The one crossing into wasm (ADR-0017) — no call site touches the runtime
   *  directly, so a Rust fault surfaces as a {@link RuntimeFault} here instead
   *  of unwinding into the serial read loop or a timer callback. */
  private bridge: RuntimeBridge | null = null;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** The cloud half (LLM/MQTT/Figma), lifted out of this class (ADR-0009). The
   *  reactor supplies the two runtime re-entry seams the performer needs. */
  private readonly cloudPerformer: CloudPerformer;
  /** The MIDI half (Web MIDI): the browser twin of the desktop `MidiManager`.
   *  Inbound messages re-enter via the same `deliverMessage` path MQTT uses. */
  private readonly midiPerformer: MidiPerformer;
  /** Edges of the flow the runtime is executing — kept from the last
   *  {@link applyFlow} so `dispatchEvent` routes component events onto exactly
   *  the wires the runtime fired them across. */
  private edges: FlowEdge[] = [];
  private disposed = false;

  private constructor(
    /** The board this flow drives, or `null` when there is none: the software
     *  half of a flow (Hotkey, Interval, Llm, Mqtt, Midi, …) runs perfectly well
     *  without hardware, and refusing to run it left the whole flow dead in the
     *  browser until a board was plugged in. Outbound Firmata bytes have nowhere
     *  to go and are dropped. */
    private readonly connection: BoardConnection | null,
    cloud: CloudDeps | null,
    private readonly onEngineFault: ((message: string) => void) | undefined,
  ) {
    this.cloudPerformer = new CloudPerformer(
      cloud,
      // LLM result re-entry: inject on the node's handle and apply the cascade it
      // drives (mirrors the desktop `ActorMsg::Inject` → `inject_event`).
      (source, handle, value) => {
        this.turn("injectEvent", source, (rt) =>
          rt.injectEvent(source, handle, JSON.stringify(value), now()),
        );
      },
      // Inbound broker message re-entry: route to the subscribe node and apply
      // (mirrors the desktop `ActorMsg::Deliver` → `deliver_message`).
      (nodeId, topic, payload) => {
        this.turn("deliverMessage", nodeId, (rt) =>
          rt.deliverMessage(nodeId, topic, payload, now()),
        );
      },
      // Figma handshake policy: core's `figma_announce_actions` via the wasm
      // binding, so the browser announces identically to the desktop host.
      figmaAnnounceActions,
    );
    this.midiPerformer = new MidiPerformer((nodeId, portName, bytes) => {
      this.turn("deliverMessage", nodeId, (rt) =>
        rt.deliverMessage(nodeId, portName, bytes, now()),
      );
    });
  }

  /** Instantiate the wasm runtime and seed its pin table from the detection
   *  session's discovered capabilities (so inbound decode + analog math work).
   *  `cloud` supplies the provider/broker lookups cloud nodes need; omit it and
   *  cloud requests are logged and skipped. */
  static async attach(
    connection: BoardConnection | null,
    cloud?: CloudDeps,
    options: AttachOptions = {},
  ): Promise<FlowReactor> {
    const reactor = new FlowReactor(connection, cloud ?? null, options.onEngineFault);
    const runtime = options.runtime ?? (await createFlowRuntime());
    reactor.bridge = new RuntimeBridge(runtime, (fault) => {
      reactor.handleFault(fault);
    });
    // A missing pin seed is survivable (inbound decode degrades); the bridge
    // reports it and the reactor still attaches.
    // No board means no pin table: the runtime keeps its empty one, inbound
    // decode has nothing to decode, and the software nodes run as usual.
    reactor.bridge.call("setPins", null, (rt) => {
      rt.setPins(connection?.session.pinsJson() ?? "[]");
    });
    return reactor;
  }

  /** Apply a flow graph (the core `FlowUpdate` shape, serialised here — the
   *  one place the flow crosses into wasm). */
  applyFlow(flow: FlowUpdateShape): void {
    if (this.disposed) return;
    this.edges = flow.edges;
    this.turn("updateFlow", null, (rt) => rt.updateFlow(JSON.stringify(flow), now()));
    this.reconcile();
  }

  /** Deliver one host-originated input to a node's port — the browser twin of
   *  the desktop actor's `ActorMsg::Key`/`component_call` paths. Used by the
   *  hotkey listener; the runtime owns all routing from there. */
  dispatchToNode(nodeId: string, port: string, value: unknown): void {
    this.turn("dispatch", nodeId, (rt) =>
      rt.dispatch(nodeId, port, JSON.stringify(value), now()),
    );
  }

  /** Feed raw inbound serial bytes (from the Web Serial read loop). */
  feedBytes(bytes: Uint8Array): void {
    this.turn("feedBytes", null, (rt) => rt.feedBytes(bytes, now()));
  }

  /** Tear down: cancel every pending timer, tear down the cloud performer (abort
   *  in-flight cloud calls + end broker connections), and drop the runtime. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.cloudPerformer.dispose();
    this.midiPerformer.dispose();
    this.bridge?.dispose();
    this.bridge = null;
  }

  /** Cross into wasm for one effects-producing op and apply what comes back. A
   *  fault yields `null` — already classified and surfaced by
   *  {@link handleFault} — and this turn is simply dropped. */
  private turn(op: string, node: string | null, fn: (rt: FlowRuntimeCalls) => string): void {
    if (this.disposed) return;
    const effectsJson = this.bridge?.call(op, node, fn);
    if (typeof effectsJson === "string") this.apply(effectsJson);
  }

  /** Apply one turn's effects in the canonical order (ADR-0008). The order
   *  lives in {@link applyEffects} (mirroring the Rust `Effects::apply`); this
   *  reactor is the `EffectsSink` supplying the browser primitives below. */
  private apply(effectsJson: string): void {
    // The wasm shim returns `""` for a turn that produced nothing — the common
    // case for an inbound serial chunk whose pin values did not move. Bail
    // before `JSON.parse` rather than parsing six empty arrays per read.
    if (effectsJson === "") return;
    let fx: Effects;
    try {
      fx = JSON.parse(effectsJson) as Effects;
    } catch (error) {
      // The call returned, so the module is not poisoned — but a reply the host
      // cannot decode still costs this turn its bytes, timers and cloud requests.
      this.handleFault(decodeFault("effects", error));
      return;
    }
    applyEffects(fx, this);
  }

  /**
   * Route one wasm fault to the surface that fits it (ADR-0017).
   *
   * - `engineBroken` → the board-level error state, via the host callback. The
   *   engine is gone, so this is not one node's problem; the host stops driving
   *   a corpse rather than retrying forever.
   * - `badInput` with a node → that node's diagnostic badge, the same surface
   *   the runtime's own `node_diagnostics` effect uses.
   * - `badInput` without a node → the console. `feedBytes`/`updateFlow` belong
   *   to no single node, and pinning the badge on an arbitrary one would lie.
   * - `disposed` → the console only. The fault that closed the bridge was
   *   already surfaced; a badge here would blame a node for a dead engine.
   */
  private handleFault(fault: RuntimeFault): void {
    if (fault.kind === "engineBroken") {
      console.error(`[flow-reactor] wasm engine fault in ${fault.op}:`, fault.message);
      this.onEngineFault?.(`The flow engine stopped: ${fault.message}`);
      return;
    }
    if (fault.kind === "badInput" && fault.node !== null) {
      this.reportDiagnostic({ node: fault.node, level: "error", message: fault.message });
      return;
    }
    console.warn(`[flow-reactor] ${fault.op} ${fault.kind}:`, fault.message);
  }

  /** Reconcile the runtime's subscriber wirings into the cloud performer's live
   *  WSS subscriptions after every `applyFlow`. The collapse + winner-selection is
   *  core policy (`reconcile_desired`); the wasm binding hands back an
   *  already-reconciled desired set (one per topic), which the performer diffs
   *  against its live set. */
  private reconcile(): void {
    if (this.disposed) return;
    const subsJson = this.bridge?.call("reconcileSubscriptions", null, (rt) =>
      rt.reconcileSubscriptions(),
    );
    if (typeof subsJson !== "string") return;
    let reconciled: ActiveSub[];
    try {
      reconciled = JSON.parse(subsJson) as ActiveSub[];
    } catch (error) {
      this.handleFault(decodeFault("reconcileSubscriptions", error));
      return;
    }
    this.cloudPerformer.reconcile(reconciled);
    const midiJson = this.bridge?.call("midiListeners", null, (rt) => rt.midiListeners());
    if (typeof midiJson !== "string") return;
    let midiListeners: MidiListener[];
    try {
      midiListeners = JSON.parse(midiJson) as MidiListener[];
    } catch (error) {
      this.handleFault(decodeFault("midiListeners", error));
      return;
    }
    this.midiPerformer.reconcile(midiListeners);
  }

  // --- EffectsSink: the browser platform primitives (ADR-0008) ---------------

  writeBytes(bytes: number[]): void {
    // Nothing to write to without a board. The node that produced these bytes
    // already says it needs hardware (its "desktop only" badge, or the sidebar's
    // "Connect board"), so this stays quiet rather than logging per turn.
    if (this.connection === null) return;
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
      // Nothing here may throw: a timer callback has no caller to catch it. The
      // bridge is what makes that true (ADR-0017).
      this.turn("wake", wakeup.nodeId, (rt) => rt.wake(wakeup.nodeId, wakeup.method, now()));
    }, wakeup.delayMs);
    this.timers.set(wakeup.id, handle);
  }

  /** Perform a cloud node's outbound call (ADR-0009) by delegating to the
   *  {@link CloudPerformer}, which owns the MQTT/LLM services + the in-flight LLM
   *  task table. The ordering (cloud before UI events) is fixed by
   *  {@link applyEffects}; this just supplies the primitive. */
  performCloud(request: CloudRequest): void {
    // MIDI is host-peripheral I/O, not a network call — the MidiPerformer owns
    // it (mirrors the desktop actor intercepting `MidiSend` before delegating).
    if (request.kind === "midiSend") {
      this.midiPerformer.send(request.deviceName, request.bytes);
      return;
    }
    this.cloudPerformer.perform(request);
  }

  dispatchEvent(event: ComponentEvent): void {
    applyComponentEvent(event, this.edges);
  }

  reportDiagnostic(diagnostic: NodeDiagnostic): void {
    useNodeDiagnosticsStore.getState().apply(diagnostic);
  }
}
