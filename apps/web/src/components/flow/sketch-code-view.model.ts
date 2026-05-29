import type { Edge, Node } from "@xyflow/react";
import type { GenerationOutcome } from "@/lib/bindings/GenerationOutcome";
import type { ValidationProblem } from "@/lib/bindings/ValidationProblem";

/**
 * The `generate_sketch` command payload: the current Flow graph plus the
 * selected board target id, wrapped for the Tauri command (see
 * `apps/web/src/lib/ipc.ts`, Task #43 and Task #45). `targetId` is omitted when
 * the Flow has no explicit selection, in which case the backend uses the
 * default board target so existing Flows still generate.
 */
export type GenerateSketchCommand = {
  type: "generate_sketch";
  flow: { nodes: Node[]; edges: Edge[] };
  targetId?: string;
};

/**
 * Response shape returned by `invokeCommand` for `generate_sketch`. The data is
 * a {@link GenerationOutcome}: either the generated `.ino` source (`sketch`) or
 * the validation problems that prevented emission (`problems`). Absent on
 * web/no-op.
 */
export type SketchResponse =
  | { success: true; data?: GenerationOutcome }
  | { success: false; error: string };

/** Injectable invoker so the projection is testable without Tauri. */
export type SketchInvoker = (command: GenerateSketchCommand) => Promise<SketchResponse>;

/** True when an outcome carries a generated sketch (rather than problems). */
function isSketchOutcome(outcome: GenerationOutcome): outcome is { sketch: string } {
  return "sketch" in outcome;
}

/**
 * Render a list of validation problems as a read-only comment block for the
 * editor. Each problem names its Node and the constraint it violated, so the
 * Author sees exactly why no sketch was emitted.
 */
function formatProblems(problems: ValidationProblem[]): string {
  const header = "// Cannot generate a sketch for the selected board:";
  const lines = problems.map((p) => `// - ${p.message}`);
  return [header, ...lines].join("\n");
}

/** View state consumed by the read-only Monaco editor. */
export type SketchViewState = {
  /** Text rendered in the editor — the sketch, or the error message on failure. */
  value: string;
  /** True when `value` holds an error message rather than a sketch. */
  isError: boolean;
};

/**
 * Placeholder text shown in the editor before the first sketch arrives. The
 * Download control treats this as "nothing to hand off yet" (see
 * `canDownloadSketch`).
 */
export const GENERATING_SKETCH_PLACEHOLDER = "// Generating sketch…";

/**
 * The `SketchDownloaded` intent — emitted when the Author activates the Download
 * control. It carries the exact sketch string the Code view currently displays.
 * The downstream write task (#31) consumes this to perform the disk write.
 */
export type SketchDownloadRequest = {
  type: "SketchDownloaded";
  /** The displayed sketch, byte-for-byte. */
  sketch: string;
  /** Suggested `.ino` filename derived from the Flow name (or `sketch.ino`). */
  suggestedFilename: string;
};

/** Handler seam invoked when the Author activates the Download control. */
export type SketchDownloadHandler = (request: SketchDownloadRequest) => void;

/**
 * Whether the Download control should be enabled for the given view state.
 *
 * Enabled whenever a real sketch is displayed — including sketches that contain
 * placeholder comments for unsupported / Cloud Nodes and sketches generated for
 * an unnamed Flow. Disabled only when there is nothing meaningful to hand off:
 * the not-yet-generated placeholder, an empty value, or a generation error.
 */
export function canDownloadSketch(state: SketchViewState): boolean {
  if (state.isError) return false;
  if (state.value === "") return false;
  if (state.value === GENERATING_SKETCH_PLACEHOLDER) return false;
  return true;
}

/**
 * Build the `SketchDownloaded` intent from the displayed sketch and a suggested
 * filename. The sketch is carried through unchanged so the file written
 * downstream matches the Code view byte-for-byte. The filename defaults to
 * `sketch.ino` so a download can always proceed even before a Flow name exists.
 */
export function buildSketchDownloadRequest(
  sketch: string,
  suggestedFilename = "sketch.ino",
): SketchDownloadRequest {
  return { type: "SketchDownloaded", sketch, suggestedFilename };
}

/**
 * Build the `generate_sketch` command from the current Flow graph and the
 * selected board target. `targetId` is omitted when no board is selected so the
 * backend falls back to the default target.
 */
export function buildGenerateSketchCommand(
  nodes: Node[],
  edges: Edge[],
  targetId?: string,
): GenerateSketchCommand {
  const command: GenerateSketchCommand = { type: "generate_sketch", flow: { nodes, edges } };
  if (targetId !== undefined) command.targetId = targetId;
  return command;
}

/**
 * Produce a stable string key for a Flow graph and selected target so
 * successive snapshots can be compared cheaply. Two inputs that would generate
 * the same sketch must yield the same key, so we serialize the same
 * `{ nodes, edges }` payload sent to the generator together with the selected
 * `targetId`. Including the target means switching the board re-generates even
 * when the graph is unchanged. Used to skip redundant regeneration otherwise.
 */
export function serializeFlowGraph(nodes: Node[], edges: Edge[], targetId?: string): string {
  return JSON.stringify({ flow: buildGenerateSketchCommand(nodes, edges).flow, targetId });
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
  targetId?: string,
): Promise<SketchViewState> {
  const response = await invoker(buildGenerateSketchCommand(nodes, edges, targetId));

  if (!response.success) {
    return { value: `// Failed to generate sketch:\n// ${response.error}`, isError: true };
  }

  // No outcome (web/no-op) resolves to a stable empty value.
  if (response.data === undefined) return { value: "", isError: false };

  // A sketch renders verbatim; validation problems render as an error block so
  // the panel never shows unrunnable code.
  if (isSketchOutcome(response.data)) {
    return { value: response.data.sketch, isError: false };
  }
  return { value: formatProblems(response.data.problems), isError: true };
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
  schedule: (nodes: Node[], edges: Edge[], targetId?: string) => void;
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

  function run(nodes: Node[], edges: Edge[], targetId?: string): void {
    const serialized = serializeFlowGraph(nodes, edges, targetId);
    if (!hasFlowChanged(serialized, lastSerialized)) return;
    lastSerialized = serialized;

    const requestId = ++latestRequestId;
    void projectSketchResult(options.invoker, nodes, edges, targetId).then((state) => {
      // Drop stale responses: only the most recent request may update the view.
      if (cancelled || requestId !== latestRequestId) return;
      options.onResult(state);
    });
  }

  return {
    schedule(nodes, edges, targetId) {
      if (cancelled) return;
      if (pendingHandle !== undefined) timers.clearTimeout(pendingHandle);
      pendingHandle = timers.setTimeout(() => {
        pendingHandle = undefined;
        run(nodes, edges, targetId);
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
