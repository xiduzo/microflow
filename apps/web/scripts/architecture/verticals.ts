/**
 * VERTICALS: the public surface of every top-level folder in apps/web/src.
 *
 * Read this table like the `exports` map of a package.json. Each vertical lists the files that
 * OTHER verticals may import, as paths relative to the vertical's folder. In a pattern, `*`
 * matches any run of characters, `/` included (the same as an `exports` subpath pattern).
 * Every file that no entry matches is internal to its vertical.
 *
 * There are deliberately no required `index.ts` barrels. A barrel invites ESM import cycles
 * (TDZ errors at startup) and drags a whole vertical into every lazy route chunk
 * (`*.lazy.tsx`). Explicit entry files keep the dependency graph and the chunks small.
 *
 * src/architecture.test.ts enforces this table. Every import counts: static, `export … from`,
 * dynamic `import()`, side-effect `import "…"`, and `mock.module("…")` in tests. Files under a
 * `generated/` folder are never checked as importers. The rules:
 *
 *   public-surface    An import from vertical A into vertical B (A ≠ B) must target a file in
 *                     B.public. `import type` counts too: type coupling is still coupling.
 *   routes-are-top    No vertical imports routes/** or a root file. They compose the verticals.
 *   infra-layer       `layer: "infra"` verticals (lib, ui, platform) import only each other.
 *   restricted-file   A `restricted` file may be imported at runtime only by its own vertical
 *                     and its `allowedImporters`. `import type` is exempt (erased at compile).
 *   unknown-vertical  Every folder and file directly in src/ must be listed here (VERTICALS or
 *                     ROOT_FILES), so new code has to pick a home.
 *
 * To (re)seed the `public` lists from the imports that exist today, run:
 *
 *   bun apps/web/scripts/architecture/derive-public-surface.ts
 */
import type { ArchitectureConfig, VerticalSpec } from "./engine";

export const VERTICALS: Record<string, VerticalSpec> = {
  // ── Top layer: routes compose the verticals. Nothing imports them. ─────────────────────
  routes: { layer: "top", public: [] },

  // ── Feature verticals (domain code, named after CONTEXT.md terms) ──────────────────────
  nodes: {
    // TODO(phase 1): seed from derive-public-surface. Planned surface: catalog.generated.ts,
    // node-types.generated.ts, node-data.ts, container/*.
    public: [],
    restricted: {
      "node-types.generated.ts": {
        allowedImporters: ["editor", "flows"],
        reason:
          "it is the xyflow NodeTypes map, which pulls in the React UI of every node. Non-UI code imports nodes/catalog.generated.ts instead (types, ports, emits, schemas, defaults, adapters; no React).",
      },
    },
  },
  // TODO(phase 4): seed from derive-public-surface.
  editor: { public: [] },
  session: { public: ["index.ts"] },
  // TODO(phase 3): seed from derive-public-surface.
  runtime: { public: [] },
  // TODO(phase 3): seed from derive-public-surface.
  board: { public: [] },
  // TODO(phase 2): seed from derive-public-surface.
  cloud: { public: [] },
  // TODO(phase 4): seed from derive-public-surface.
  ai: { public: [] },
  // TODO(phase 4): seed from derive-public-surface.
  sketch: { public: [] },
  // TODO(phase 4): seed from derive-public-surface.
  circuit: { public: [] },
  // TODO(phase 4): seed from derive-public-surface.
  flows: { public: [] },
  // TODO(phase 4): seed from derive-public-surface.
  community: { public: [] },
  // TODO(phase 4): seed from derive-public-surface.
  account: { public: [] },
  // TODO(phase 4): seed from derive-public-surface.
  devtools: { public: [] },
  // TODO(phase 4): seed from derive-public-surface.
  shell: { public: [] },

  // ── Infrastructure: imports only other infrastructure ──────────────────────────────────
  // TODO(phase 4): seed from derive-public-surface.
  platform: { layer: "infra", public: [] },
  ui: { layer: "infra", public: ["*"] },
  lib: { layer: "infra", public: ["*"] },
};

/** Files allowed directly in src/. They sit in the top layer, next to routes/. */
export const ROOT_FILES: readonly string[] = [
  "main.tsx",
  "index.css",
  "routeTree.gen.ts",
  "architecture.test.ts",
];

export const ARCHITECTURE: ArchitectureConfig = {
  verticals: VERTICALS,
  rootFiles: ROOT_FILES,
  configPath: "apps/web/scripts/architecture/verticals.ts",
};
