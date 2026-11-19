import type { NodeHostAdapter } from "../_base/host-adapter";
import { brokerIds } from "../_base/broker-binding.adapter";

export const adapter: NodeHostAdapter = {
  prepareData: (_node, hosts) =>
    hosts.figma.uniqueId ? { uniqueId: hosts.figma.uniqueId } : undefined,
  brokerIds,
};
