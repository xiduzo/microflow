import type { Edge, Node } from "@xyflow/react";

/**
 * The `generate_sketch` command payload: the current Flow graph wrapped for the
 * Tauri command (see `apps/web/src/lib/ipc.ts` and Task #45).
 */
export type GenerateSketchCommand = {
  type: "generate_sketch";
  flow: { nodes: Node[]; edges: Edge[] };
};

/**
 * Response shape returned by `invokeCommand` for `generate_sketch`. The data is
 * the generated `.ino` source as a plain string (or absent on web/no-op).
 */
export type SketchResponse = { success: true; data?: string } | { success: false; error: string };

/** Injectable invoker so the projection is testable without Tauri. */
export type SketchInvoker = (command: GenerateSketchCommand) => Promise<SketchResponse>;

/** View state consumed by the read-only Monaco editor. */
export type SketchViewState = {
  /** Text rendered in the editor — the sketch, or the error message on failure. */
  value: string;
  /** True when `value` holds an error message rather than a sketch. */
  isError: boolean;
};

/** Build the `generate_sketch` command from the current Flow graph. */
export function buildGenerateSketchCommand(nodes: Node[], edges: Edge[]): GenerateSketchCommand {
  return { type: "generate_sketch", flow: { nodes, edges } };
}

/**
 * Produce a stable string key for a Flow graph so successive snapshots can be
 * compared cheaply. Two graphs that would generate the same sketch must yield
 * the same key, so we serialize the same `{ nodes, edges }` payload sent to the
 * generator. Used to skip redundant regeneration when the graph is unchanged.
 */
export function serializeFlowGraph(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify(buildGenerateSketchCommand(nodes, edges).flow);
}

/**
 * Decide whether the current graph differs from the last one we generated a
 * sketch for. `undefined` means nothing has been generated yet, so the first
 * snapshot always regenerates.
 */
export function hasFlowChanged(current: string, lastGenerated: string | undefined): boolean {
  return current !== lastGenerated;
}

/**
 * Request a freshly generated sketch for the given Flow and project the response
 * into editor view state. On success the editor shows the sketch (empty string
 * when the generator returns nothing); on failure it shows the error text rather
 * than crashing the panel.
 */
export async function projectSketchResult(
  invoker: SketchInvoker,
  nodes: Node[],
  edges: Edge[],
): Promise<SketchViewState> {
  const response = await invoker(buildGenerateSketchCommand(nodes, edges));

  if (response.success) {
    return { value: response.data ?? "", isError: false };
  }

  return { value: `// Failed to generate sketch:\n// ${response.error}`, isError: true };
}

/** Default debounce window (ms) — balances responsiveness against churn. */
export const DEFAULT_REGENERATE_DEBOUNCE_MS = 400;

/** Timer primitives, injectable so the regenerator is testable with a fake clock. */
export type RegeneratorTimers = {
  setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

const realTimers: RegeneratorTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export type DebouncedRegenerator = {
  /**
   * Register the latest Flow graph. Coalesces rapid calls into a single
   * regeneration that fires after the debounce window elapses with no further
   * calls. Skips work when the graph matches the last one generated.
   */
  schedule: (nodes: Node[], edges: Edge[]) => void;
  /** Cancel any pending regeneration and drop in-flight responses (call on unmount). */
  cancel: () => void;
};

/**
 * Create a debounced, coalescing sketch regenerator.
 *
 * - Rapid `schedule` calls collapse into one regeneration after the author pauses.
 * - The regeneration always uses the latest graph (last-writer-wins).
 * - Identical graphs are skipped (no redundant `generate_sketch`).
 * - Only the latest in-flight response is applied; stale responses are dropped
 *   to avoid flicker.
 *
 * `onResult` receives the projected view state when a regeneration completes.
 * `seedSerialized` primes the "last generated" key (e.g. the on-open snapshot)
 * so the first identical edit does not trigger a redundant regeneration.
 */
export function createDebouncedRegenerator(options: {
  invoker: SketchInvoker;
  onResult: (state: SketchViewState) => void;
  debounceMs?: number;
  timers?: RegeneratorTimers;
  seedSerialized?: string;
}): DebouncedRegenerator {
  const debounceMs = options.debounceMs ?? DEFAULT_REGENERATE_DEBOUNCE_MS;
  const timers = options.timers ?? realTimers;

  let pendingHandle: ReturnType<typeof setTimeout> | undefined;
  let lastSerialized = options.seedSerialized;
  let latestRequestId = 0;
  let cancelled = false;

  function run(nodes: Node[], edges: Edge[]): void {
    const serialized = serializeFlowGraph(nodes, edges);
    if (!hasFlowChanged(serialized, lastSerialized)) return;
    lastSerialized = serialized;

    const requestId = ++latestRequestId;
    void projectSketchResult(options.invoker, nodes, edges).then((state) => {
      // Drop stale responses: only the most recent request may update the view.
      if (cancelled || requestId !== latestRequestId) return;
      options.onResult(state);
    });
  }

  return {
    schedule(nodes, edges) {
      if (cancelled) return;
      if (pendingHandle !== undefined) timers.clearTimeout(pendingHandle);
      pendingHandle = timers.setTimeout(() => {
        pendingHandle = undefined;
        run(nodes, edges);
      }, debounceMs);
    },
    cancel() {
      cancelled = true;
      if (pendingHandle !== undefined) {
        timers.clearTimeout(pendingHandle);
        pendingHandle = undefined;
      }
      // Invalidate any in-flight response.
      latestRequestId++;
    },
  };
}
