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

import { useNodeDataStore } from "@/stores/node-data";
import { useSignalStore } from "@/stores/signal";
import { createFlowRuntime, type Effects, type FlowRuntime } from "@/lib/runtime/wasm";
import type { BoardConnection } from "./web-serial";

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
export class FlowReactor {
  private runtime: FlowRuntime | null = null;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private edges: CoreEdge[] = [];
  private disposed = false;

  private constructor(private readonly connection: BoardConnection) {}

  /** Instantiate the wasm runtime and seed its pin table from the detection
   *  session's discovered capabilities (so inbound decode + analog math work). */
  static async attach(connection: BoardConnection): Promise<FlowReactor> {
    const reactor = new FlowReactor(connection);
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
  }

  /** Feed raw inbound serial bytes (from the Web Serial read loop). */
  feedBytes(bytes: Uint8Array): void {
    if (!this.runtime || this.disposed) return;
    this.apply(this.runtime.feedBytes(bytes, now()));
  }

  /** Tear down: cancel every pending timer and drop the runtime. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.runtime = null;
  }

  /** Apply one turn's effects: write bytes, reconcile timers, render events. */
  private apply(effectsJson: string): void {
    if (this.disposed) return;
    let fx: Effects;
    try {
      fx = JSON.parse(effectsJson) as Effects;
    } catch (error) {
      console.error("[flow-reactor] bad effects json:", error);
      return;
    }

    if (fx.outboundBytes.length > 0) {
      void this.connection.write(Uint8Array.from(fx.outboundBytes)).catch((error: unknown) => {
        console.warn("[flow-reactor] write failed:", error);
      });
    }

    for (const id of fx.cancellations) {
      const handle = this.timers.get(id);
      if (handle !== undefined) {
        clearTimeout(handle);
        this.timers.delete(id);
      }
    }

    for (const wakeup of fx.wakeups) {
      const handle = setTimeout(() => {
        this.timers.delete(wakeup.id);
        if (!this.runtime || this.disposed) return;
        this.apply(this.runtime.wake(wakeup.nodeId, wakeup.method, now()));
      }, wakeup.delayMs);
      this.timers.set(wakeup.id, handle);
    }

    if (fx.componentEvents.length > 0) {
      const updateNodeData = useNodeDataStore.getState().update;
      const addSignal = useSignalStore.getState().addSignal;
      for (const event of fx.componentEvents) {
        if (event.sourceHandle === "value" || event.sourceHandle === "event") {
          updateNodeData(event.source, event.value);
        } else if (event.sourceHandle === "thinking") {
          updateNodeData(`${event.source}:thinking`, event.value);
        }
        for (const edge of this.edges) {
          if (edge.id && edge.source === event.source && edge.sourceHandle === event.sourceHandle) {
            addSignal(edge.id);
          }
        }
      }
    }
  }
}
