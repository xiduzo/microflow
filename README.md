# Microflow

<a href="https://www.producthunt.com/products/microflow?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-microflow" target="_blank" rel="noopener noreferrer"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1195056&theme=light&t=1784200634583" alt="Microflow - Microcontrollers made simple. | Product Hunt" width="250" height="54" /></a>

**A visual tool for building interactive prototypes connected to real hardware.**

Microflow lets designers and creators build interactive experiences by connecting digital interfaces to physical microcontrollers — no code required. Drag components onto a canvas, wire them together, and your prototype comes to life.

## What's included

### [Microflow Studio](apps/web) — Desktop App
A visual, flow-based interface built as a cross-platform desktop app. Connect nodes, map signals, and control hardware in real time.

### [Microflow Server](apps/server) — Backend
A Hono + tRPC server handling auth, persistence, and real-time collaboration.

### [Microflow Hardware Bridge](apps/figma-plugin) — Figma Plugin
An optional Figma plugin that bridges Figma prototypes to Microflow Studio via MQTT, so hardware can respond to Figma interactions.

### [Microflow Docs](apps/fumadocs) — Documentation
The documentation site, built with Next.js and Fumadocs.

## Tech stack

This is a **T-stack** monorepo:

| Tool | Role |
|---|---|
| [Turborepo](https://turbo.build) | Monorepo build system |
| [Tauri](https://tauri.app) | Cross-platform desktop shell |
| [tRPC](https://trpc.io) | End-to-end typesafe API |
| [TanStack](https://tanstack.com) | Router, Query, Form |
| [Tailwind CSS v4](https://tailwindcss.com) | Styling |
| [Hono](https://hono.dev) | HTTP server |
| [Better Auth](https://better-auth.com) | Authentication |
| [Drizzle ORM](https://orm.drizzle.team) | Database ORM (PostgreSQL) |
| [MQTT](https://mqtt.org) | Hardware communication protocol |
| [Yjs](https://yjs.dev) | Real-time collaboration |
| [Bun](https://bun.sh) | Package manager & runtime |

## Getting started

### Prerequisites

- [Bun](https://bun.sh) `>= 1.3.5`
- [Docker](https://www.docker.com) (for the database)
- [Rust](https://www.rust-lang.org) (for the desktop app)

### Setup

```bash
bun install
```

Start the database:

```bash
bun db:start
bun db:push
```

Run everything in dev mode:

```bash
bun dev
```

Or run specific apps:

```bash
bun dev:web      # Desktop app
bun dev:server   # Backend server
```

For the Figma plugin, navigate to `apps/figma-plugin`:

```bash
cd apps/figma-plugin && bun dev
```

Then import the plugin in Figma via **Plugins → Development → Import plugin from manifest** and select `apps/figma-plugin/manifest.json`.

## Project structure

```
microflow/
├── apps/
│   ├── web/           # Desktop app (React + Tauri + TanStack Router)
│   ├── server/        # Backend API (Hono + tRPC)
│   ├── figma-plugin/  # Figma plugin (MQTT bridge)
│   └── fumadocs/      # Documentation site (Next.js + Fumadocs)
└── packages/
    ├── api/           # tRPC router definitions
    ├── auth/          # Better Auth configuration
    ├── collab/        # Yjs collaboration layer
    ├── db/            # Drizzle schema & migrations
    ├── env/           # Type-safe environment variables
    ├── mqtt/          # MQTT client shared between apps
    └── config/        # Shared TypeScript & lint config
```

## Available scripts

| Script | Description |
|---|---|
| `bun dev` | Start all apps in dev mode |
| `bun dev:web` | Start only the desktop app |
| `bun dev:server` | Start only the backend |
| `bun build` | Build all apps |
| `bun check-types` | TypeScript type check across all apps |
| `bun check` | Lint & format with Oxlint + Oxfmt |
| `bun db:start` | Start PostgreSQL via Docker |
| `bun db:push` | Push schema changes |
| `bun db:migrate` | Run migrations |
| `bun db:studio` | Open Drizzle Studio |
| `bun db:stop` | Stop the database |

## Links

- [Figma Community Plugin](https://www.figma.com/community/plugin/1373258770799080545)
- [Documentation](apps/fumadocs)
