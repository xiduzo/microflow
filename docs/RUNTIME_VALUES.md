# Runtime Values Architecture

## Overview

This document explains the design decision to keep runtime values (node execution state) separate from the Yjs synchronization layer.

## Architecture Decision

**Runtime values are NOT synced via Yjs.** Each user sees only their local hardware values.

```
┌─────────────────────────────────────────────────────────────────┐
│                    What Gets Synced (Yjs)                       │
├─────────────────────────────────────────────────────────────────┤
│  ✓ Node positions, dimensions                                   │
│  ✓ Node configuration (pin assignments, settings)               │
│  ✓ Edge connections                                             │
│  ✓ Flow metadata (name, description)                            │
│  ✓ User presence (cursors, selections)                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                 What Stays Local (Zustand)                      │
├─────────────────────────────────────────────────────────────────┤
│  ✗ Node runtime values (LED on/off, sensor readings)            │
│  ✗ Hardware connection state                                    │
│  ✗ Signal animations on edges                                   │
│  ✗ Execution state                                              │
└─────────────────────────────────────────────────────────────────┘
```

## Rationale

### 1. Semantic Correctness

Runtime values represent the state of a specific user's hardware. When User A presses their physical button, that's User A's button press - it shouldn't appear on User B's screen as if User B's button was pressed.

Each collaborator may have:
- Different hardware connected (or none at all)
- Different physical states (User A's LED is on, User B's is off)
- Different timing (network latency would make synced values confusing)

### 2. Performance

Syncing runtime values would flood the Yjs document with updates:
- Analog sensors can produce 60+ readings per second
- Oscillators generate continuous value streams
- Button hold events fire repeatedly

This would:
- Overwhelm the WebSocket connection
- Bloat the Yjs document history
- Create merge conflicts on rapid updates

### 3. Yjs Purpose

Yjs is designed for collaborative document editing - the "blueprint" of the flow. It excels at:
- Conflict-free merging of structural changes
- Offline support with eventual consistency
- Undo/redo across all collaborators

Runtime execution is fundamentally different - it's ephemeral, local, and real-time.

## Implementation

### Node Value Store (`stores/node-data.ts`)

```typescript
// Local-only store for runtime values
const useNodeDataStore = create<NodeData>((set) => ({
  data: {},
  update: (id, data) => set((state) => ({
    data: { ...state.data, [id]: data }
  })),
  clear: () => set({ data: {} }),
}));

// Hook for nodes to read their current value
export function useNodeValue<T>(defaultValue: T) {
  const id = useNodeId();
  return useNodeDataStore((state) => state.data[id] ?? defaultValue);
}
```

### Signal Store (`stores/signal.ts`)

Edge animations (showing data flow) are also local-only:

```typescript
// Signals are visual feedback, not persisted state
const useSignalStore = create<SignalState>((set, get) => ({
  signals: new Map(),
  addSignal: (edgeId) => { /* ... */ },
  // Auto-cleanup after animation duration
}));
```

## Future Considerations

### Collaborative Debugging Mode

A future feature could add an opt-in "share execution" mode where users can broadcast their runtime values for debugging purposes. This would be:
- Explicitly enabled per-session
- Sent via a separate channel (not Yjs)
- Clearly marked as "User A's values" in the UI

### Execution Recording

For tutorials or demos, we could record a sequence of runtime values and play them back. This would be stored separately from the flow document.

## Related Files

- `apps/web/src/stores/node-data.ts` - Runtime value store
- `apps/web/src/stores/signal.ts` - Edge animation store
- `packages/collab/src/schema.ts` - FlowDocument (Yjs wrapper)
- `docs/SYNC_ARCHITECTURE.md` - Overall sync design
