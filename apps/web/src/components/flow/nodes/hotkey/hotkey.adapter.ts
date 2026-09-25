import type { NodeHostAdapter } from "../_base/host-adapter";

export const adapter: NodeHostAdapter = {
  accelerator: (node) => (node.data?.accelerator ? String(node.data.accelerator) : undefined),
};
