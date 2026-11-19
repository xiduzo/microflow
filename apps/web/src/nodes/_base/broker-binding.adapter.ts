// The Host Adapter half of the broker binding (`./broker-binding.ts`): which
// brokers a node depends on. A leaf on purpose — the Component Catalog imports
// every node's adapter, and the binding itself needs React and the broker
// store.

import type { NodeHostAdapter } from "./host-adapter";

/** The broker a node is bound to, as the list a Host Adapter reports. */
export const brokerIds: NonNullable<NodeHostAdapter["brokerIds"]> = (node) =>
  node.data?.brokerId ? [node.data.brokerId as string] : [];
