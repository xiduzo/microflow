// The one crossing into the wasm flow runtime (ADR-0017).
//
// Every entry point of `microflow-runtime-wasm` returns `Result<String, JsError>`,
// which is a *throw* on the JS side, and a Rust panic is a wasm trap. This
// module is the single place those faults are
// caught, classified, and routed. Callers get `undefined` back and never a throw,
// which is what keeps an engine fault out of the transport layer: the Web Serial
// read loop can no longer mistake a decode defect for an unplugged board, and a
// timer callback — which has no caller to catch it — cannot become an unhandled
// rejection.
//
// A trapped instance stays mechanically callable — the trap unwinds the JS call
// but does not destroy the module. What it destroys is the runtime's invariants:
// the panic aborted mid-mutation and no destructor ran, so the engine's state is
// indeterminate and any flow it drives afterwards is undefined. The bridge
// therefore latches closed by policy, not because wasm forces it, and drops
// subsequent calls without re-entering — which is also what stops a
// deterministic fault from becoming an infinite retry loop.

import type { DesiredSub } from "@/lib/bindings/DesiredSub";
import type { Effects } from "@/lib/bindings/Effects";
import type { FlowUpdate } from "@/lib/bindings/FlowUpdate";
import type { MidiListener } from "@/lib/bindings/MidiListener";

/**
 * The runtime surface the bridge calls, declared structurally so this module
 * needs no value import of the wasm glue (and so tests can drive a double). The
 * generated `FlowRuntime` satisfies it.
 */
export interface FlowRuntimeCalls {
  setPins(pinsJson: string): void;
  updateFlow(json: string, nowMs: number): string;
  feedBytes(bytes: Uint8Array, nowMs: number): string;
  wake(nodeId: string, method: string, nowMs: number): string;
  dispatch(id: string, method: string, valueJson: string, nowMs: number): string;
  injectEvent(source: string, handle: string, valueJson: string, nowMs: number): string;
  deliverMessage(id: string, topic: string, payload: Uint8Array, nowMs: number): string;
  reconcileSubscriptions(): string;
  midiListeners(): string;
}

/**
 * The fault taxonomy. Exactly three things can go wrong at the crossing:
 *
 * - `badInput` — the runtime rejected this call (a Rust `Err`, arriving as a
 *   plain `Error`). The module is intact; only this turn is lost.
 * - `engineBroken` — a wasm trap (Rust panic, stack exhaustion). The runtime's
 *   invariants are gone, so the bridge latches closed; no flow runs again on it.
 * - `disposed` — the bridge is already closed (torn down, or latched after a
 *   trap) and the call never reached wasm. Reported once, then silent.
 */
export type RuntimeFaultKind = "badInput" | "engineBroken" | "disposed";

/** One classified fault at the wasm crossing. */
export type RuntimeFault = {
  kind: RuntimeFaultKind;
  /** The runtime entry point that faulted, e.g. `"feedBytes"`. */
  op: string;
  /** The node the call was made on behalf of, or `null` for whole-flow ops. */
  node: string | null;
  /** Human-readable detail, safe to show on a badge or in a toast. */
  message: string;
};

/**
 * A wasm trap: a Rust panic, or stack/memory exhaustion inside the module. The
 * instance survives it, but its internal state does not — see the module header
 * for why the bridge treats this as terminal. `RangeError` is how the glue
 * surfaces a stack overflow that unwound on the JS side of the call.
 */
function isTrap(error: unknown): boolean {
  return (
    (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) ||
    error instanceof RangeError
  );
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns one wasm runtime and every call into it — including the call codec: the
 * op name, the JSON encode of arguments, and the decode of replies into the
 * ts-rs binding types all live behind the typed entry points below, so callers
 * never touch a JSON string or cast a result. Construct with the runtime and
 * the fault handler; {@link dispose} on teardown.
 */
export class RuntimeBridge {
  private runtime: FlowRuntimeCalls | null;
  private readonly onFault: (fault: RuntimeFault) => void;
  /** A closed bridge reports the first dropped call and then stays quiet —
   *  wakeups and inbound chunks keep arriving, and one fault per chunk would
   *  flood the console and the node badges. */
  private reportedClosed = false;

  constructor(runtime: FlowRuntimeCalls, onFault: (fault: RuntimeFault) => void) {
    this.runtime = runtime;
    this.onFault = onFault;
  }

  /** False once disposed or poisoned — no further call reaches wasm. */
  get live(): boolean {
    return this.runtime !== null;
  }

  // --- Typed entry points, one per runtime op the host uses ------------------

  /** Seed the runtime's pin table (the JSON comes straight from the detection
   *  session, so it crosses as-is). */
  setPins(pinsJson: string): void {
    this.call("setPins", null, (rt) => {
      rt.setPins(pinsJson);
    });
  }

  /** Apply a flow graph — the one place the flow crosses into wasm. */
  updateFlow(flow: FlowUpdate, nowMs: number): Effects | undefined {
    return this.effectsTurn("updateFlow", null, (rt) =>
      rt.updateFlow(JSON.stringify(flow), nowMs),
    );
  }

  /** Feed raw inbound serial bytes. */
  feedBytes(bytes: Uint8Array, nowMs: number): Effects | undefined {
    return this.effectsTurn("feedBytes", null, (rt) => rt.feedBytes(bytes, nowMs));
  }

  /** Fire a timer wakeup the runtime armed. */
  wake(nodeId: string, method: string, nowMs: number): Effects | undefined {
    return this.effectsTurn("wake", nodeId, (rt) => rt.wake(nodeId, method, nowMs));
  }

  /** Deliver one host-originated input (e.g. a hotkey) to a node's port. */
  dispatch(nodeId: string, port: string, value: unknown, nowMs: number): Effects | undefined {
    return this.effectsTurn("dispatch", nodeId, (rt) =>
      rt.dispatch(nodeId, port, JSON.stringify(value), nowMs),
    );
  }

  /** Re-enter with a cloud result on a node's emit handle. */
  injectEvent(
    source: string,
    handle: string,
    value: unknown,
    nowMs: number,
  ): Effects | undefined {
    return this.effectsTurn("injectEvent", source, (rt) =>
      rt.injectEvent(source, handle, JSON.stringify(value), nowMs),
    );
  }

  /** Route one inbound broker/MIDI message to its subscribe node. */
  deliverMessage(
    nodeId: string,
    topic: string,
    payload: Uint8Array,
    nowMs: number,
  ): Effects | undefined {
    return this.effectsTurn("deliverMessage", nodeId, (rt) =>
      rt.deliverMessage(nodeId, topic, payload, nowMs),
    );
  }

  /** The already-reconciled desired subscription set (one winner per topic). */
  reconcileSubscriptions(): DesiredSub[] | undefined {
    const reply = this.call("reconcileSubscriptions", null, (rt) => rt.reconcileSubscriptions());
    if (reply === undefined) return undefined;
    return this.decode<DesiredSub[]>("reconcileSubscriptions", null, reply);
  }

  /** Every MIDI in-node's device interest. */
  midiListeners(): MidiListener[] | undefined {
    const reply = this.call("midiListeners", null, (rt) => rt.midiListeners());
    if (reply === undefined) return undefined;
    return this.decode<MidiListener[]>("midiListeners", null, reply);
  }

  // --- The core crossing -----------------------------------------------------

  /** An effects-producing op: cross, then decode the turn's `Effects`. The wasm
   *  shim returns `""` for a turn that produced nothing — the common case for an
   *  inbound serial chunk whose pin values did not move — which decodes to
   *  `undefined` without parsing six empty arrays per read. */
  private effectsTurn(
    op: string,
    node: string | null,
    fn: (runtime: FlowRuntimeCalls) => string,
  ): Effects | undefined {
    const reply = this.call(op, node, fn);
    if (reply === undefined || reply === "") return undefined;
    return this.decode<Effects>(op, node, reply);
  }

  /** Decode one reply into its ts-rs binding type. The shape is guaranteed by
   *  the Rust side (the bindings are generated from the same structs serde
   *  serialises), so `JSON.parse` is the whole validation. A reply the host
   *  cannot decode still cost the turn, but the call itself returned — the
   *  module is intact, so this is `badInput` in the taxonomy, routed like any
   *  other fault rather than thrown at the call site. */
  private decode<T>(op: string, node: string | null, json: string): T | undefined {
    try {
      return JSON.parse(json) as T;
    } catch (error) {
      this.onFault({
        kind: "badInput",
        op,
        node,
        message: `undecodable ${op} reply: ${detailOf(error)}`,
      });
      return undefined;
    }
  }

  /**
   * Invoke one runtime entry point. Returns what the call returned (the effects
   * JSON, or `undefined` for a void op such as `setPins`), or `undefined` if it
   * faulted — in which case the fault has already been classified and routed.
   * Never throws.
   *
   * `node` is the node the call is on behalf of, or `null` for a whole-flow op
   * (`feedBytes`, `updateFlow`, …) that belongs to no single node.
   */
  private call(
    op: string,
    node: string | null,
    fn: (runtime: FlowRuntimeCalls) => string | void,
  ): string | undefined {
    const runtime = this.runtime;
    if (runtime === null) {
      this.closedFault(op, node);
      return undefined;
    }
    try {
      return fn(runtime) ?? undefined;
    } catch (error) {
      const trap = isTrap(error);
      // Latch closed BEFORE routing, so the handler sees a bridge that is already
      // dead and nothing it does can call back into a runtime whose state is gone.
      if (trap) this.runtime = null;
      this.onFault({
        kind: trap ? "engineBroken" : "badInput",
        op,
        node,
        message: detailOf(error),
      });
      return undefined;
    }
  }

  dispose(): void {
    this.runtime = null;
    // A deliberate teardown is not a fault: nothing after it needs reporting.
    this.reportedClosed = true;
  }

  private closedFault(op: string, node: string | null): void {
    if (this.reportedClosed) return;
    this.reportedClosed = true;
    this.onFault({
      kind: "disposed",
      op,
      node,
      message: "The flow engine is no longer running.",
    });
  }
}
