import type { NodeHostAdapter } from "../_base/host-adapter";

export const adapter: NodeHostAdapter = {
  brokerIds: (node) => (node.data?.brokerId ? [node.data.brokerId as string] : []),
};
