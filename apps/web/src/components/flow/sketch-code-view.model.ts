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
export type SketchResponse =
  | { success: true; data?: string }
  | { success: false; error: string };

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
export function buildGenerateSketchCommand(
  nodes: Node[],
  edges: Edge[],
): GenerateSketchCommand {
  return { type: "generate_sketch", flow: { nodes, edges } };
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
