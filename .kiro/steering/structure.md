# Project Structure

```
microflow-t-stack/
├── apps/
│   ├── web/                    # Main React application + Tauri desktop
│   │   ├── src/                # One folder per domain (ADR-0027)
│   │   │   ├── routes/         # TanStack Router pages; compose the folders below
│   │   │   ├── nodes/          # Node type implementations + generated catalog
│   │   │   ├── editor/         # Canvas: edges, panels, sheets, new-node dialog
│   │   │   ├── session/        # FlowSession, sync adapters, ReactFlowBridge
│   │   │   ├── runtime/        # Browser runtime host (wasm engine)
│   │   │   ├── board/          # Board connection (Web Serial, Firmata)
│   │   │   ├── cloud/          # MQTT + Figma connections
│   │   │   ├── ai/             # Ask AI + LLM providers
│   │   │   ├── sketch/         # Arduino sketch export
│   │   │   ├── circuit/        # Circuit view
│   │   │   ├── flows/          # Flow library, templates, flow dialogs
│   │   │   ├── community/      # Community flows
│   │   │   ├── account/        # Auth, sign-in, user menu
│   │   │   ├── devtools/       # Microflow devtools drawer
│   │   │   ├── shell/          # App sidebar + navigation
│   │   │   ├── platform/       # Host detection, Tauri IPC
│   │   │   ├── ui/             # shadcn/ui components (design system)
│   │   │   └── lib/            # App-wide infra: tRPC, analytics, ts-rs bindings
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
├── {node-name}.schema.ts  # Zod schema for data/value types + defaults
└── {node-name}.adapter.ts # Optional host adapter (no React)
```

Nodes are registered by codegen, not by hand: add the entry to `apps/web/node-components.json` and run `bun run catalog:sync` in `apps/web`.

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
