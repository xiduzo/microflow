// The contract between a Sketch consumer (the Code view) and the generator
// backend — Tauri IPC on desktop, wasm in the browser (see ./index.ts). Only
// types live here, so a consumer can depend on the protocol without pulling in
// either transport.

import type { Edge, Node } from "@xyflow/react";
import type { Credentials } from "@/lib/bindings/Credentials";
import type { GenerationOutcome } from "@/lib/bindings/GenerationOutcome";

/**
 * The `generate_sketch` command payload: the current Flow graph plus the
 * selected board target id, wrapped for the Tauri command (see
 * `apps/web/src/platform/ipc.ts`, Task #43 and Task #45). `targetId` is omitted when
 * the Flow has no explicit selection, in which case the backend uses the
 * default board target so existing Flows still generate.
 */
export type GenerateSketchCommand = {
  type: "generate_sketch";
  flow: { nodes: Node[]; edges: Edge[] };
  targetId?: string;
  /**
   * Author-supplied network credentials a Cloud-capable Sketch uses to connect
   * on boot (Task #46). Omitted for non-Cloud Flows; secrets are session-only
   * and never persisted in the Flow.
   */
  credentials?: Credentials;
};

/**
 * Response shape returned by `invokeCommand` for `generate_sketch`. The data is
 * a {@link GenerationOutcome}: the generated `.ino` source (`sketch`, `null`
 * only when an error-severity problem blocked emission) plus any validation
 * `problems`. Absent on web/no-op.
 */
export type SketchResponse =
  | { success: true; data?: GenerationOutcome }
  | { success: false; error: string };

/** Injectable invoker so the projection is testable without Tauri. */
export type SketchInvoker = (command: GenerateSketchCommand) => Promise<SketchResponse>;
