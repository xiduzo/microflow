import type { FlowDocument, FlowNode } from "@microflow/collab";
import type { HostState, NodeHostAdapter } from "@/components/flow/nodes/_base/host-adapter";
import type { LlmProviderConfig } from "@/stores/llm-provider";
import type { MqttBrokerConfig } from "@/stores/mqtt-broker";
import type { FlowSession } from "./flow-session";
import type {
  DispatchedBroker,
  DispatchedProvider,
  FlowUpdate,
  FlowUpdateSender,
  SendResult,
} from "./flow-update-sender";

/** Minimal shape the dispatcher needs from the (codegen'd) NODE_REGISTRY:
 * lookup by instance name → optional host adapter. Injecting it instead of
 * importing the codegen module decouples the dispatcher from the generated
 * `_REGISTRY.ts` (which transitively imports every node component + its
 * auth/env-touching deps), making the dispatcher testable in isolation. */
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
 * `registry` is the codegen'd `NODE_REGISTRY` in production; tests pass a
 * minimal stub so they don't pull the whole node tree into the test bundle.
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

/** Compose the helpers. Pure: same `(doc, snapshot, registry)` → same `FlowUpdate`. */
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
    nodes,
    edges: doc.getEdges(),
    brokers: gatherBrokers(brokerIds, snapshot.brokers),
    providers: gatherProviders(snapshot.providers),
  };
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

  private requestDispatch(): void {
    if (this.destroyed) return;
    this.scheduler.schedule(() => {
      void this.dispatchNow();
    });
  }

  /** Build and send a `FlowUpdate` immediately, bypassing the scheduler. */
  async dispatchNow(): Promise<SendResult> {
    if (this.destroyed) return { ok: false, error: "dispatcher destroyed" };
    const update = buildFlowUpdate(this.session.doc, this.snapshotProvider(), this.registry);
    const result = await this.sender.send(update);
    if (!result.ok) {
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
