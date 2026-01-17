# Sync Architecture

## Overview

This document describes the refactored synchronization architecture between the database, Yjs, and local state.

## Core Principle: Yjs as Single Source of Truth

The fundamental change is that **Yjs is now the single source of truth** for flow data. Everything else derives from it.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT                                       │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    FlowDocument (Yjs-First)                      ││
│  │  ┌─────────────────────────────────────────────────────────────┐││
│  │  │ Y.Doc                                                        │││
│  │  │  ├─ Y.Map("meta") → { name, description, version }          │││
│  │  │  ├─ Y.Map("nodes") → Map<nodeId, NodeData>                  │││
│  │  │  └─ Y.Map("edges") → Map<edgeId, EdgeData>                  │││
│  │  └─────────────────────────────────────────────────────────────┘││
│  │                              │                                   ││
│  │                    ┌─────────┴─────────┐                        ││
│  │                    ▼                   ▼                        ││
│  │  ┌─────────────────────┐  ┌─────────────────────┐              ││
│  │  │ React Hooks         │  │ Yjs UndoManager     │              ││
│  │  │ (useSyncExternalStore)│ │ (built-in history)  │              ││
│  │  └─────────────────────┘  └─────────────────────┘              ││
│  └─────────────────────────────────────────────────────────────────┘│
│                              │                                       │
│                    ┌─────────┴─────────┐                            │
│                    ▼                   ▼                            │
│  ┌─────────────────────┐  ┌─────────────────────┐                  │
│  │ SyncProvider        │  │ localStorage        │                  │
│  │ (WebSocket)         │  │ (local flows)       │                  │
│  └─────────────────────┘  └─────────────────────┘                  │
│                    │                                                │
└────────────────────┼────────────────────────────────────────────────┘
                     │
                     ▼
              ┌─────────────┐
              │   Server    │
              │  (YjsServer)│
              └─────────────┘
                     │
                     ▼
              ┌─────────────┐
              │  PostgreSQL │
              │  (ydoc)     │
              └─────────────┘
```

## Key Components

### 1. FlowDocument (`packages/collab/src/schema.ts`)

A wrapper around Y.Doc that provides:
- Type-safe operations for nodes and edges
- Uses Y.Map instead of Y.Array for O(1) updates
- Built-in UndoManager for undo/redo
- Observable changes for React integration

```typescript
const flowDoc = FlowDocument.createEmpty();
flowDoc.addNode({ id: "1", type: "button", position: { x: 0, y: 0 }, data: {} });
flowDoc.undo(); // Built-in undo
```

### 2. SyncProvider (`packages/collab/src/sync-provider.ts`)

Handles WebSocket synchronization:
- Connects to server via WebSocket
- Queues updates when offline
- Automatic reconnection with exponential backoff
- Awareness (presence) management

### 3. YjsServer (`packages/collab/src/yjs-server.ts`)

Server-side room management:
- One room per flowId
- Broadcasts updates to all connected clients
- Debounced persistence to database
- Sends ACK after successful persistence

### 4. React Hooks

- `useFlowNodes(flowDoc)` - Subscribe to nodes changes
- `useFlowEdges(flowDoc)` - Subscribe to edges changes
- `useFlowHistory(flowDoc)` - Undo/redo with UndoManager
- `useSyncProvider(options)` - Connect to collaboration server

## Data Flow

### Local Edit → Server → Database

1. User edits node in UI
2. `onNodesChange` calls `flowDoc.updateNode()`
3. FlowDocument updates Y.Map (with "local" origin)
4. Y.Doc emits "update" event
5. SyncProvider sends update via WebSocket
6. YjsServer broadcasts to other clients
7. YjsServer schedules debounced persistence
8. After 2s, YjsServer persists to database
9. YjsServer sends ACK to all clients

### Remote Update → Local State

1. Another client sends update via WebSocket
2. YjsServer broadcasts to all clients
3. SyncProvider receives update
4. SyncProvider applies to local Y.Doc (with "remote" origin)
5. React hooks detect change via useSyncExternalStore
6. UI re-renders

## Key Improvements Over Previous Architecture

1. **Single Source of Truth**: No more dual state between Zustand and Yjs
2. **Efficient Updates**: Y.Map instead of delete-and-replace with Y.Array
3. **Built-in Undo/Redo**: Uses Yjs UndoManager instead of manual history
4. **No Origin Tracking Bugs**: Clean separation of local vs remote updates
5. **Offline Support Ready**: SyncProvider queues updates when disconnected
6. **Acknowledgment Protocol**: Server confirms persistence to clients

## File Structure

```
packages/collab/src/
├── schema.ts          # FlowDocument class
├── sync-provider.ts   # Client-side sync
├── yjs-server.ts      # Server-side rooms
├── handler.ts         # Hono WebSocket handler
└── index.ts           # Public exports

apps/web/src/
├── stores/
│   └── flow-store.ts  # Zustand store (thin wrapper)
└── hooks/
    ├── use-flow-document.ts  # React bindings
    ├── use-sync-provider.ts  # Sync hook
    └── use-collab-flow.ts    # Combined hook
```

## Usage Examples

### Local Flow (No Collaboration)

```tsx
function LocalFlowPage() {
  const { initLocalFlow, destroy } = useFlowInit();
  const flowDoc = useFlowDocument();
  const nodes = useFlowNodes(flowDoc);
  const edges = useFlowEdges(flowDoc);

  useEffect(() => {
    initLocalFlow();
    return () => destroy();
  }, []);

  return <ReactFlow nodes={nodes} edges={edges} />;
}
```

### Collaborative Flow

```tsx
function CollabFlowPage({ flowId, user }) {
  const { initCloudFlow, destroy } = useFlowInit();
  const flowDoc = useFlowDocument();
  
  useEffect(() => {
    initCloudFlow(flowId, initialYdocData);
    return () => destroy();
  }, [flowId]);

  const sync = useSyncProvider({
    flowDoc,
    flowId,
    user,
    wsUrl: "wss://server.example.com",
  });

  const nodes = useFlowNodes(flowDoc);
  const edges = useFlowEdges(flowDoc);

  return (
    <>
      <SyncStatus state={sync.state} />
      <ReactFlow nodes={nodes} edges={edges} />
    </>
  );
}
```
