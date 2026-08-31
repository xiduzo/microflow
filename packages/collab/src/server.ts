// Server-side exports (Node.js only - uses database)
export { YjsServer } from "./yjs-server";
export type { YjsServerOptions, Connection, RoomConnection, Access } from "./yjs-server";
export type { RoomStore } from "./room-store";
export { MemoryRoomStore } from "./room-store";
export { drizzleRoomStore } from "./drizzle-room-store";

export { createYjsHandler, yjsServer } from "./handler";

// Re-export client types for convenience
export { FlowDocument, upgradeLegacyNodes } from "./schema";
export type { FlowMeta, FlowNode, FlowEdge, FlowData } from "./schema";

// The client/server wire contract — see `protocol.ts`.
export {
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  MESSAGE_AUTH,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_ACK,
  CLOSE_ACCESS_DENIED,
} from "./protocol";
