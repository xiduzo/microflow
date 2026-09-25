// Per-node hooks the flow store + global hotkey listener consult.
// Mirrors the runtime-side `Component::listener_wiring` / `subscriber_wiring`
// pattern: the node module owns its instance-specific behavior; the host
// walks the registry instead of pattern-matching `data.instance`.
//
// Each method is optional; a node only declares the hooks it cares about.

import type { FlowNode } from "@microflow/collab";

/** Read-only slice of zustand stores the adapter may consult. */
export type HostState = {
  figma: { uniqueId: string | null };
};

export type NodeHostAdapter = {
  /**
   * Called once per node during the desktop-sync step.
   * Return a partial `data` patch to merge in, or `undefined` to leave the node alone.
   */
  prepareData?: (node: FlowNode, hosts: HostState) => Record<string, unknown> | undefined;

  /** Broker IDs this node depends on; collected and forwarded to the runtime. */
  brokerIds?: (node: FlowNode) => string[];

  /** Keyboard accelerator this node listens to; registered with `useHotkeys`. */
  accelerator?: (node: FlowNode) => string | undefined;
};
