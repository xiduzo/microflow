# Tech Stack

## Build System
- **Monorepo**: Turborepo with Bun workspaces
- **Package Manager**: Bun (v1.3.5)
- **Linting/Formatting**: Oxlint + Oxfmt

## Frontend (apps/web)
- **Framework**: React 19 with Vite
- **Routing**: TanStack Router (file-based)
- **State**: Zustand + Yjs (collaboration)
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Flow Editor**: @xyflow/react
- **Forms**: TanStack Form + Zod
- **Desktop**: Tauri (Rust backend)

## Backend (apps/server)
- **Runtime**: Bun
- **Framework**: Hono
- **API**: tRPC (end-to-end type safety)
- **Auth**: Better-Auth with Polar.sh payments
- **Real-time**: WebSocket with Yjs sync

## Database
- **Engine**: PostgreSQL
- **ORM**: Drizzle ORM
- **Migrations**: drizzle-kit

## Documentation (apps/fumadocs)
- **Framework**: Next.js 16 with Fumadocs

## Common Commands

```bash
# Install dependencies
bun install

# Development (all apps)
bun run dev

# Individual apps
bun run dev:web      # Web app only
bun run dev:server   # Server only

# Desktop app (from apps/web)
bun run desktop:dev
bun run desktop:build

# Database
bun run db:start     # Start PostgreSQL (Docker)
bun run db:push      # Push schema changes
bun run db:studio    # Open Drizzle Studio
bun run db:generate  # Generate migrations
bun run db:migrate   # Run migrations

# Type checking & linting
bun run check-types
bun run check        # Oxlint + Oxfmt

# Build
bun run build
```

## Key Dependencies (Catalog)
Shared versions managed in root package.json catalog:
- zod: ^4.1.13
- typescript: ^5
- @trpc/server: ^11.7.2
- better-auth: ^1.4.9
- drizzle-orm: ^0.45.1
