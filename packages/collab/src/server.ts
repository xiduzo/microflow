// Server-side exports (Node.js only - uses database)
export { YjsServer } from "./yjs-server";
export type { YjsServerOptions, Connection } from "./yjs-server";

export { createYjsHandler, yjsServer } from "./handler";

// Re-export client types for convenience
export { FlowDocument } from "./schema";
export type { FlowMeta, FlowNode, FlowEdge, FlowData } from "./schema";
