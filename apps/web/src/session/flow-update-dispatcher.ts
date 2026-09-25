import type { FlowDocument, FlowNode } from "@microflow/collab";
import { projectFlowStructure } from "@microflow/collab/schema";
import type { HostState, NodeHostAdapter } from "@/nodes/_base/host-adapter";
import type { LlmProviderConfig } from "@/ai/llm-provider";
import type { MqttBrokerConfig } from "@/cloud/mqtt-broker";
import type { FlowSession } from "./flow-session";
import type {
  DispatchedBroker,
  DispatchedProvider,
  FlowUpdate,
  FlowUpdateSender,
  SendResult,
} from "./flow-update-sender";

/** Minimal shape the dispatcher needs from the (codegen'd) NODE_CATALOG:
 * lookup by instance name → optional host adapter. Injecting it instead of
 * importing the codegen module decouples the dispatcher from the generated
 * `catalog.generated.ts`, so tests can hand it a stub with exactly the
 * adapters they exercise. */
export type NodeAdapterRegistry = Record<string, { adapter?: NodeHostAdapter } | undefined>;

// =========================================================================
// Snapshot of host state the dispatcher needs at dispatch time
// =========================================================================

export type HostSnapshot = {
  brokers: MqttBrokerConfig[];
  providers: LlmProviderConfig[];
  figma: { uniqueId: string | null };
};

export type HostSnapshotProvider = () => HostSnapshot;

// =========================================================================
// Scheduler abstraction (injectable for tests)
// =========================================================================

export interface DispatchScheduler {
  schedule(callback: () => void): void;
  cancel(): void;
}

/**
 * Production scheduler: debounce with a ceiling.
 *
 * A plain reset-on-every-call debounce never fires while edits keep arriving,
 * and in a room with several contributors that is the steady state — the
 * runtime would simply stop receiving flow updates for as long as anybody was
 * typing. `maxWaitMs` bounds the starvation: once a dispatch has been pending
 * that long, the next request runs instead of re-arming.
 */
export class DebounceScheduler implements DispatchScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => void) | null = null;
  private firstRequestAt = 0;

  constructor(
    private readonly waitMs: number,
    private readonly maxWaitMs: number,
  ) {}

  schedule(callback: () => void): void {
    this.pending = callback;
    const now = Date.now();
    if (this.timer === null) this.firstRequestAt = now;

    if (now - this.firstRequestAt >= this.maxWaitMs) {
      this.run();
      return;
    }

    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), this.waitMs);
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  private run(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const callback = this.pending;
    this.pending = null;
    callback?.();
  }
}

/** Test scheduler. Stores the callback; `flush()` runs it synchronously. */
export class ManualDispatchScheduler implements DispatchScheduler {
  private pending: (() => void) | null = null;

  schedule(callback: () => void): void {
    this.pending = callback;
  }

  cancel(): void {
    this.pending = null;
  }

  /** Run the pending callback (no-op if none). */
  flush(): void {
    const fn = this.pending;
    this.pending = null;
    fn?.();
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }
}

// =========================================================================
// Pure helpers — composable, independently testable
// =========================================================================

/**
 * Walk each node's `NodeHostAdapter` to apply `prepareData` patches and
 * collect broker IDs the runtime needs to know about.
 *
 * `registry` is the codegen'd `NODE_CATALOG` in production; tests pass a
 * minimal stub with only the adapters they exercise.
 */
export function applyHostAdapterPatches(
  rawNodes: FlowNode[],
  hostState: HostState,
  registry: NodeAdapterRegistry,
): { nodes: FlowNode[]; brokerIds: Set<string> } {
  const brokerIds = new Set<string>();
  const nodes = rawNodes.map((node) => {
    const instance = node.data?.instance;
    if (typeof instance !== "string") return node;
    const adapter = registry[instance]?.adapter;
    if (!adapter) return node;

    let patched = node;
    const patch = adapter.prepareData?.(node, hostState);
    if (patch) {
      patched = { ...node, data: { ...node.data, ...patch } };
    }
    for (const id of adapter.brokerIds?.(patched) ?? []) {
      brokerIds.add(id);
    }
    return patched;
  });
  return { nodes, brokerIds };
}

/** Filter brokers by the set of IDs referenced by adapters; project to the
 * wire shape. */
export function gatherBrokers(
  brokerIds: Set<string>,
  allBrokers: MqttBrokerConfig[],
): DispatchedBroker[] {
  return allBrokers
    .filter((b) => brokerIds.has(b.id))
    .map((b) => ({
      id: b.id,
      name: b.name,
      url: b.url,
      username: b.username,
      password: b.password,
    }));
}

/** Project all LLM provider configs to the snake-case wire shape the
 * runtime expects. */
export function gatherProviders(allProviders: LlmProviderConfig[]): DispatchedProvider[] {
  return allProviders.map((p) => ({
    id: p.id,
    name: p.name,
    base_url: p.baseUrl,
    api_key: p.apiKey,
  }));
}

/**
 * Compose the helpers. Pure: same `(doc, snapshot, registry)` → same `FlowUpdate`.
 *
 * This is the single place the editor's collab shapes are projected into the
 * core `FlowUpdate` wire shape (visual-only fields dropped, optional handles
 * defaulted to `""` as core's `FlowEdge` requires) — both senders forward the
 * result untouched.
 */
export function buildFlowUpdate(
  doc: FlowDocument,
  snapshot: HostSnapshot,
  registry: NodeAdapterRegistry,
): FlowUpdate {
  const { nodes, brokerIds } = applyHostAdapterPatches(
    doc.getNodes(),
    { figma: snapshot.figma },
    registry,
  );
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type ?? null,
      data: node.data,
      position: node.position,
    })),
    edges: doc.getEdges().map((edge) => ({
      id: edge.id ?? null,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? "",
      targetHandle: edge.targetHandle ?? "",
    })),
    brokers: gatherBrokers(brokerIds, snapshot.brokers),
    providers: gatherProviders(snapshot.providers),
  };
}

/**
 * A stable key over only the fields the runtime consumes: the Flow's
 * structural projection (see `projectFlowStructure` — node position,
 * selection and dimensions are stripped, nodes and edges sorted) plus the
 * brokers and providers the runtime needs credentials for. The dispatcher
 * uses this to skip scheduled dispatches that carry no runtime-relevant
 * change, which is what stops a node move from tearing down and rebuilding
 * every downstream MQTT/Figma subscription.
 */
export function runtimeRelevantKey(update: FlowUpdate): string {
  return JSON.stringify({
    structure: projectFlowStructure(update.nodes, update.edges),
    brokers: update.brokers,
    providers: update.providers,
  });
}

// =========================================================================
// FlowUpdateDispatcher class — desktop-only observer + scheduler + sender
// =========================================================================

/**
 * Observes the `FlowSession`'s doc for any Y-update (local edits AND
 * remote sync arrivals), schedules a dispatch via the injected
 * `DispatchScheduler` (production: debounced), then builds and sends a
 * `FlowUpdate` payload through the injected `FlowUpdateSender`.
 *
 * Construction fires an immediate dispatch request so the runtime gets
 * the current flow on mount, matching the legacy `setupDocSync` behaviour.
 *
 * Lifecycle: `destroy()` unobserves the doc and cancels any pending
 * scheduled dispatch. Idempotent.
 */
export class FlowUpdateDispatcher {
  private unobserve: () => void;
  private destroyed = false;
  /** Key of the last successfully-sent update; lets the scheduled path skip
   *  dispatches with no runtime-relevant delta (e.g. a node was only moved). */
  private lastDispatchKey: string | null = null;

  constructor(
    private readonly session: FlowSession,
    private readonly snapshotProvider: HostSnapshotProvider,
    private readonly sender: FlowUpdateSender,
    private readonly scheduler: DispatchScheduler,
    private readonly registry: NodeAdapterRegistry,
  ) {
    this.unobserve = session.doc.onAnyChange(() => this.requestDispatch());
    // Fire once on mount so the runtime sees the current flow.
    this.requestDispatch();
  }

  /** Incremented per send, so a response that lands out of order can be
   *  recognised as stale rather than overwriting a newer key. */
  private dispatchSequence = 0;
  private latestDispatchSequence = 0;

  private requestDispatch(): void {
    if (this.destroyed) return;
    this.scheduler.schedule(() => {
      if (this.destroyed) return;
      const update = buildFlowUpdate(this.session.doc, this.snapshotProvider(), this.registry);
      // Skip when nothing the runtime cares about changed — a pure node
      // move/selection must not churn downstream MQTT/Figma subscriptions.
      // Forced dispatches (`dispatchNow`) deliberately bypass this.
      // The key is computed once and handed to `send`: it is a full
      // JSON serialisation of the flow, and computing it again on the way out
      // doubled that cost on every accepted change from anyone in the room.
      const key = runtimeRelevantKey(update);
      if (key === this.lastDispatchKey) return;
      void this.send(update, key);
    });
  }

  /** Build and send a `FlowUpdate` immediately, bypassing the scheduler and the
   *  no-delta skip. */
  async dispatchNow(): Promise<SendResult> {
    if (this.destroyed) return { ok: false, error: "dispatcher destroyed" };
    return this.send(buildFlowUpdate(this.session.doc, this.snapshotProvider(), this.registry));
  }

  /**
   * Send one update; remember its key on success so the next scheduled
   * dispatch can detect a no-op.
   *
   * Sends are not serialised — `dispatchNow` can overlap the debounced path —
   * so an older send completing last must not install its key as the latest.
   * That would make the *next* genuinely-different update look like a repeat
   * and skip it.
   */
  private async send(update: FlowUpdate, precomputedKey?: string): Promise<SendResult> {
    const sequence = ++this.dispatchSequence;
    const result = await this.sender.send(update);

    if (result.ok) {
      if (sequence > this.latestDispatchSequence) {
        this.latestDispatchSequence = sequence;
        this.lastDispatchKey = precomputedKey ?? runtimeRelevantKey(update);
      }
    } else {
      console.error("[FLOW-DISPATCH] failed:", result.error);
    }
    return result;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unobserve();
    this.scheduler.cancel();
  }
}
