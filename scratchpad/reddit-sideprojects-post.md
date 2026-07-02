# Microflow — a visual tool for wiring up interactive prototypes to real hardware (no code)

**TL;DR:** Drag nodes onto a canvas, wire them together, and control real microcontrollers in real time. Designers can prototype physical/interactive experiences without writing code. Open source, built as a cross-platform desktop app.

---

I've been building **Microflow**, a visual flow-based tool for connecting digital interfaces to physical hardware.

The idea: a lot of interaction designers want to prototype things that respond to the real world — a button that lights up an LED, a sensor that drives an animation, a Figma prototype that talks to a physical device — but the gap between "I can design it" and "I can wire up firmware" is huge. Microflow tries to close that gap. You drop components on a canvas, connect them, map signals, and your prototype is live.

**What it does:**
- Visual node editor — wire inputs/outputs together, no code
- Talks to real microcontrollers over **MQTT** in real time
- Optional **Figma plugin** so Figma prototypes can drive (or react to) hardware
- Real-time collaboration so multiple people can work on the same flow

**The nerdy part (why it's a fun build):**
The flow runtime is written in **Rust**, compiled to **WASM** so the exact same engine runs in the browser *and* in the desktop app — single source of truth for how nodes behave across hosts. The cross-language node contract (which ports/emits exist) is enforced at compile time so the TS and Rust sides can't drift.

**Stack:** Tauri (desktop shell) · React + TanStack Router · Rust/WASM runtime · tRPC + Hono backend · Drizzle + Postgres · Better Auth · Yjs for collab · Bun · Turborepo monorepo.

It's still early but the core loop works end to end. Would love feedback — especially from anyone who's done hardware prototyping or built flow/node editors before. What would make this actually useful in your workflow?

(Links to repo / docs / Figma community plugin in comments.)
