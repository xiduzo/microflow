# Project Structure

```
microflow-t-stack/
├── apps/
│   ├── web/                    # Main React application + Tauri desktop
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── flow/       # Flow editor components
│   │   │   │   │   ├── nodes/  # Node type implementations
│   │   │   │   │   ├── edges/  # Edge components
│   │   │   │   │   ├── panels/ # UI panels (dock, settings)
│   │   │   │   │   └── dialogs/# Modal dialogs
│   │   │   │   ├── ui/         # shadcn/ui components
│   │   │   │   └── hardware/   # Hardware visualization
│   │   │   ├── hooks/          # React hooks
│   │   │   ├── stores/         # Zustand stores
│   │   │   ├── routes/         # TanStack Router pages
│   │   │   ├── lib/            # Utilities
│   │   │   └── providers/      # Context providers
│   │   └── src-tauri/          # Rust backend for desktop
│   │       └── src/
│   │           ├── flasher/    # Arduino flashing
│   │           ├── hardware/   # Firmata/serial communication
│   │           └── runtime/    # Node execution engine
│   ├── server/                 # Hono API server
│   └── fumadocs/               # Documentation site
│
├── packages/
│   ├── api/                    # tRPC routers and procedures
│   ├── auth/                   # Better-Auth configuration
│   ├── collab/                 # Yjs collaboration layer
│   │   ├── schema.ts           # FlowDocument (Yjs wrapper)
│   │   ├── sync-provider.ts    # Client WebSocket sync
│   │   └── yjs-server.ts       # Server room management
│   ├── db/                     # Drizzle schema and migrations
│   │   └── src/schema/         # Table definitions
│   ├── env/                    # Environment variable validation
│   ├── mqtt/                   # MQTT client utilities
│   └── config/                 # Shared TypeScript config
│
└── docs/                       # Architecture documentation
```

## Node Component Pattern

Each flow node follows this structure:
```
nodes/{node-name}/
├── {node-name}.tsx        # React component
└── {node-name}.schema.ts  # Zod schema for data/value types
```

Nodes extend `baseDataSchema` and use:
- `NodeContainer` for consistent UI wrapper
- `useNodeControls` for Leva-based settings panel
- `useNodeData<Data>()` for typed node data access
- `useNodeValue<Value>()` for runtime values

## Sync Architecture

Yjs is the single source of truth for flow data:
1. FlowDocument wraps Y.Doc with typed operations
2. SyncProvider handles WebSocket sync to server
3. YjsServer manages rooms and persists to PostgreSQL
4. React hooks subscribe via useSyncExternalStore

See `docs/SYNC_ARCHITECTURE.md` for detailed flow diagrams.
