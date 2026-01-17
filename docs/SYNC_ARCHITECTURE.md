# Sync Architecture

## Overview

This document describes the synchronization architecture between the database, Yjs, and local state in Microflow.

## Core Principle: Yjs as Single Source of Truth

The fundamental design is that **Yjs is the single source of truth** for flow data. Everything else derives from it.

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
│  │  │ (useState+useEffect)│  │ (built-in history)  │              ││
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
- Awareness (presence) management for cursors and user info
- Emits typed events: `stateChange`, `awarenessChange`, `error`, `ack`

### 3. YjsServer (`packages/collab/src/yjs-server.ts`)

Server-side room management:

- One room per flowId
- Broadcasts updates to all connected clients
- Debounced persistence to database (2s default)
- Sends ACK after successful persistence
- Cleans up rooms when all clients disconnect

### 4. Package Exports

The `@microflow/collab` package has two entry points:

- `@microflow/collab` - Browser-safe exports (FlowDocument, SyncProvider)
- `@microflow/collab/server` - Server-only exports (YjsServer, createYjsHandler)

This separation prevents Node.js dependencies (database, dotenv) from being bundled in the browser.

## React Integration

### useFlowState Hook (`apps/web/src/hooks/use-flow-document.ts`)

The main hook for ReactFlow integration that handles bidirectional sync:

```typescript
const { nodes, edges, onNodesChange, onEdgesChange } = useFlowState(flowDoc);
```

**How it works:**

1. Maintains local React state for nodes/edges
2. Uses ReactFlow's `applyNodeChanges`/`applyEdgeChanges` for immediate UI updates
3. Batches structural changes and syncs to Yjs via `requestAnimationFrame`
4. Subscribes to Yjs observers for remote updates and undo/redo

This pattern ensures:
- Smooth dragging (synchronous local state updates)
- Proper Yjs sync (batched writes on structural changes)
- Remote collaboration (Yjs observer updates local state)

### useSyncProvider Hook (`apps/web/src/hooks/use-sync-provider.ts`)

Manages WebSocket connection lifecycle:

```typescript
const sync = useSyncProvider({
  flowDoc,
  flowId,
  user: { id, name },
  wsUrl: "wss://server.example.com",
  enabled: true,
});

// Returns:
// - state: "disconnected" | "connecting" | "syncing" | "synced"
// - isConnected, isSynced: boolean helpers
// - users: AwarenessUser[] (all connected users)
// - localUser: AwarenessUser
// - updateCursor, updateSelectedNodes: awareness actions
// - reconnect, disconnect: manual control
```

**Cleanup:** The hook automatically destroys the SyncProvider when:
- Component unmounts
- Dependencies change (flowDoc, flowId, user)
- `enabled` becomes false

### Other Hooks

- `useFlowNodes(flowDoc)` - Read-only subscription to nodes
- `useFlowEdges(flowDoc)` - Read-only subscription to edges
- `useFlowHistory(flowDoc)` - Undo/redo with UndoManager
- `useCollabPresence(sync)` - Filter other users from awareness

## Data Flow

### Local Edit → Server → Database

1. User drags node in UI
2. `onNodesChange` called with position change
3. `applyNodeChanges` updates local React state immediately
4. On drag end (structural change), sync to Yjs via `requestAnimationFrame`
5. FlowDocument updates Y.Map (with "local" origin)
6. Y.Doc emits "update" event
7. SyncProvider sends update via WebSocket
8. YjsServer broadcasts to other clients
9. YjsServer schedules debounced persistence (2s)
10. YjsServer persists to database
11. YjsServer sends ACK to all clients

### Remote Update → Local State

1. Another client sends update via WebSocket
2. YjsServer broadcasts to all clients
3. SyncProvider receives update
4. SyncProvider applies to local Y.Doc (with "remote" origin)
5. Yjs observer fires
6. `useFlowState` updates local React state
7. ReactFlow re-renders

### Route Cleanup

When leaving a collaborative flow route (`/flow/$flowId`):

1. Route component unmounts
2. `useEffect` cleanup calls `destroy()` on flow store
3. `useSyncProvider` cleanup calls `provider.destroy()`
4. SyncProvider closes WebSocket connection
5. Server removes client from room
6. If room is empty, server persists and cleans up room

## File Structure

```
packages/collab/src/
├── schema.ts          # FlowDocument class
├── sync-provider.ts   # Client-side WebSocket sync
├── yjs-server.ts      # Server-side room management
├── handler.ts         # Hono WebSocket handler
├── index.ts           # Browser-safe exports
└── server.ts          # Server-only exports

apps/web/src/
├── stores/
│   └── flow-store.ts  # Zustand store (FlowDocument holder)
└── hooks/
    ├── use-flow-document.ts  # useFlowState, useFlowNodes, etc.
    ├── use-sync-provider.ts  # WebSocket connection hook
    └── use-collab-flow.ts    # Combined hook (legacy)
```

## Usage Examples

### Local Flow (No Collaboration)

```tsx
function LocalFlowPage() {
  const { initLocalFlow, destroy } = useFlowInit();
  const flowDoc = useFlowDocument();
  const { nodes, edges, onNodesChange, onEdgesChange } = useFlowState(flowDoc);

  useEffect(() => {
    initLocalFlow();
    return () => destroy();
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
    />
  );
}
```

### Collaborative Flow

```tsx
function CollabFlowPage({ flowId, initialYdoc }) {
  const { initCloudFlow, destroy } = useFlowInit();
  const flowDoc = useFlowDocument();
  const { nodes, edges, onNodesChange, onEdgesChange } = useFlowState(flowDoc);

  // Initialize flow document
  useEffect(() => {
    initCloudFlow(flowId, initialYdoc);
    return () => destroy();
  }, [flowId]);

  // Connect to sync server
  const sync = useSyncProvider({
    flowDoc,
    flowId,
    user: { id: userId, name: userName },
    wsUrl: "wss://server.example.com",
    enabled: !!flowDoc,
  });

  const presence = useCollabPresence(sync);

  return (
    <>
      <ConnectionStatus state={sync.state} />
      <PresenceAvatars users={presence.otherUsers} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
      />
      {sync.isConnected && (
        <CollabCursors users={presence.otherUsers} />
      )}
    </>
  );
}
```

## Key Design Decisions

1. **Y.Map over Y.Array**: Enables O(1) node updates instead of delete-and-replace
2. **Separate local React state**: ReactFlow needs synchronous updates for smooth dragging
3. **Batched Yjs writes**: Only sync structural changes, not every drag frame
4. **Browser/Server split**: Prevents bundling Node.js deps in browser
5. **Automatic cleanup**: Hooks handle connection lifecycle automatically
6. **Debounced persistence**: Reduces database writes during rapid edits
