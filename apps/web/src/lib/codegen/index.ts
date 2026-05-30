// Platform-dispatching code generation: the same operations resolve to the Rust
// generator over the Tauri IPC bridge on desktop, and to that *same* Rust
// generator compiled to WebAssembly in the browser (see ./wasm.ts). Callers use
// these entry points and never branch on platform themselves.

import type { Node, Edge } from "@xyflow/react";
import { invokeCommand, checkCredentials as desktopCheckCredentials } from "@/lib/ipc";
import type { Credentials, MissingCredential } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import {
  type GenerateSketchCommand,
  type SketchInvoker,
  type SketchResponse,
} from "@/components/flow/sketch-code-view.model";
import { generateSketch as wasmGenerateSketch, checkCredentials as wasmCheckCredentials } from "./wasm";

/**
 * The {@link SketchInvoker} the Code view uses. On desktop it forwards the
 * `generate_sketch` command over Tauri IPC; in the browser it runs the wasm
 * generator and adapts its {@link GenerationOutcome} into the same
 * {@link SketchResponse} envelope, so the projection logic stays platform-blind.
 */
export const sketchInvoker: SketchInvoker = async (
  command: GenerateSketchCommand,
): Promise<SketchResponse> => {
  if (isDesktop()) {
    return invokeCommand(command) as Promise<SketchResponse>;
  }
  try {
    const data = await wasmGenerateSketch(command.flow, command.targetId, command.credentials);
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
};

/**
 * Report which required network credentials are missing for `flow` on the
 * selected target — desktop over IPC, browser over wasm. Returns an empty list
 * when nothing is required (no Cloud Nodes, or a non-networking target). Secret
 * values are never logged.
 */
export async function checkCredentials(
  flow: { nodes: Node[]; edges: Edge[] },
  targetId?: string,
  credentials?: Credentials,
): Promise<MissingCredential[]> {
  if (isDesktop()) {
    return desktopCheckCredentials(flow, targetId, credentials);
  }
  try {
    return await wasmCheckCredentials(flow, targetId, credentials);
  } catch (error) {
    console.error("[checkCredentials]", error);
    return [];
  }
}
