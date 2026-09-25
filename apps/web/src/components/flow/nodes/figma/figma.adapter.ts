import type { NodeHostAdapter } from "../_base/host-adapter";

export const adapter: NodeHostAdapter = {
  prepareData: (_node, hosts) =>
    hosts.figma.uniqueId ? { uniqueId: hosts.figma.uniqueId } : undefined,
  brokerIds: (node) => (node.data?.brokerId ? [node.data.brokerId as string] : []),
};
