import type { FlowNode } from "@microflow/collab";
import { NODE_CATALOG } from "@/nodes/catalog.generated";
import { isComponentType } from "@/nodes/component-types.generated";

/**
 * The keyboard accelerators the flow's nodes listen on: what the host has to
 * register with the keyboard. Which nodes hear a key is the runtime's business
 * (`dispatch_key_event`), so no node id leaves here.
 *
 * One entry per accelerator the runtime tells apart. It matches accelerators
 * case-insensitively, so nodes that spell one key differently share a single
 * registration (the first spelling) and a press reaches the runtime once.
 */
export function hotkeyAccelerators(nodes: readonly FlowNode[]): string[] {
  const registered = new Map<string, string>();
  for (const node of nodes) {
    const instance = node.data?.instance;
    if (typeof instance !== "string" || !isComponentType(instance)) continue;
    const accelerator = NODE_CATALOG[instance].adapter?.accelerator?.(node);
    if (!accelerator) continue;
    const identity = accelerator.toLowerCase();
    if (!registered.has(identity)) registered.set(identity, accelerator);
  }
  return [...registered.values()];
}
