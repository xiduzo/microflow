// Client-side exports (browser-safe)
export { FlowDocument, upgradeLegacyNodes, isValueEqual } from "./schema";
export type { FlowMeta, FlowNode, FlowEdge, FlowData } from "./schema";

export { SyncProvider } from "./sync-provider";
export type {
  SyncState,
  SyncProviderOptions,
  SyncProviderEvents,
  AwarenessUser,
} from "./sync-provider";

export { COLLAB_COLORS } from "./sync-provider";

// The client/server wire contract. Exported from both entry points so the
// constraint on message numbering is visible from either side.
export {
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  MESSAGE_AUTH,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_ACK,
  CLOSE_ACCESS_DENIED,
  MESSAGE_ACCESS,
  ACCESS_CODES,
  CLOSE_POLICY_VIOLATION,
  CLOSE_FLOW_GONE,
  classifyClose,
  CLOSE_SERVICE_RESTART,
  MAX_REAUTH_ATTEMPTS,
  type CloseVerdict,
  type WireAccess,
} from "./protocol";
