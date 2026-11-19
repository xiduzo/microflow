// What one vertical needs from another and must not import: handed over here,
// once, before the app renders. `main.tsx` calls `wireApp()` first thing.
//
// It is a module of its own so that a test can run exactly what the app runs
// (`app-wiring.test.ts`); `main.tsx` itself needs a browser to load.

import { nodeHandles } from "@/nodes/handles";
import { provideHandleSets } from "@/session";

export function wireApp(): void {
  // Sessions prune the edges of a handle that vanishes, and only the node
  // library knows which handles a node has. Before any session is made.
  provideHandleSets(nodeHandles);
}
