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
 * src/architecture.test.ts and the oxlint rule microflow/vertical-boundaries (oxlint-plugin.mjs)
 * enforce this table. Every import counts: static, `export … from`,
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
  // The node library: base node UI, per-node folders, the generated catalog, live values.
  nodes: {
    public: [
      "catalog.generated.ts",
      "component-types.generated.ts",
      "node-types.generated.ts",
      "node-data-resolver.ts",
      "live/node-data.ts",
      "live/node-diagnostics.ts",
      "_base/_base.tsx",
      "_base/_base.schema.ts",
      "_base/browser-support.ts",
      "_base/desktop-only-badge.tsx",
      "_base/host-adapter.ts",
      "_base/node-context.ts",
    ],
    restricted: {
      "node-types.generated.ts": {
        allowedImporters: ["editor", "flows"],
        reason:
          "it is the xyflow NodeTypes map, which pulls in the React UI of every node. Non-UI code imports nodes/catalog.generated.ts instead (types, ports, emits, schemas, defaults, adapters; no React).",
      },
    },
  },
  // The canvas: ReactFlow surface, edges, panels, sheets, the new-node dialog.
  editor: {
    public: ["react-flow-canvas.tsx", "auto-layout.ts", "handle-proximity.ts", "signal.ts"],
  },
  // FlowSession, SyncAdapters, ReactFlowBridge, Presence. The barrel is the whole surface.
  session: { public: ["index.ts"] },
  // The Runtime Host: flow reactor, EffectsSink, FlowUpdateDispatcher, event ingest.
  runtime: {
    public: [
      "dispatch-port.ts",
      "effects-sink.ts",
      "flow-reactor.ts",
      "flow-update-dispatcher.ts",
      "use-audio-requests.ts",
      "use-component-events.ts",
      "use-flow-update-dispatcher.ts",
      "use-hotkey-events.ts",
      "use-node-diagnostics.ts",
    ],
  },
  // The Board: Web Serial, bring-up, Firmata wasm, pins, first-connection onboarding.
  board: {
    public: [
      "arduino-onboarding.ts",
      "board-controller.ts",
      "board-store.ts",
      "nav-microcontroller.tsx",
      "pin.ts",
      "pin-label.tsx",
      "use-first-arduino-connection.ts",
      "wasm.ts",
      "web-serial.ts",
    ],
  },
  // Browser CloudPerformer, MQTT + design-tool bridge connections, capability probe, connection console.
  cloud: {
    public: [
      "browser-cloud-probe.ts",
      "browser-mqtt-test-client.ts",
      "cloud-capabilities.ts",
      "cloud-performer.ts",
      "connection-console/connection-console.tsx",
      "connection-console/parse-command.ts",
      "design-bridge.ts",
      "design-bridge-account.ts",
      "mqtt-broker.ts",
    ],
  },
  // Everything LLM: provider transport (ADR-0021) and the Ask AI assistant.
  ai: {
    public: [
      "ask-ai-panel.tsx",
      "ask-ai-store.ts",
      "cli-providers.ts",
      "endpoint.ts",
      "llm-client.ts",
      "llm-provider.ts",
      "models.ts",
      "use-llm-requests.ts",
    ],
  },
  // Arduino sketch export (/flow/$flowId/code).
  sketch: { public: ["sketch-code-view.tsx"] },
  // Circuit view (/flow/$flowId/circuit).
  circuit: { public: ["circuit-store.ts"] },
  // The flow library: list, thumbnails, create/share/delete, templates, import/export.
  flows: {
    public: [
      "active-flow.ts",
      "create-flow-dialog.tsx",
      "delete-flow-dialog.tsx",
      "flow-colors.ts",
      "flow-list.tsx",
      "flow-switcher.tsx",
      "flow-thumbnail.tsx",
      "share-flow-dialog.tsx",
      "templates/index.ts",
      "use-flow-import-export.ts",
    ],
  },
  community: { public: ["community-card.tsx"] },
  account: {
    public: ["auth-client.ts", "nav-user.tsx", "set-name-dialog.tsx", "sign-in-form.tsx"],
  },
  devtools: { public: ["dev-log.ts", "microflow-devtools.tsx", "use-backend-logs.ts"] },
  // App chrome: sidebar + navigation, and the one-off migration out of `microflow:app`.
  shell: { public: ["app-sidebar.tsx", "contribute.ts", "legacy-app-store.ts", "sidebar.ts"] },

  // ── Infrastructure: imports only other infrastructure ──────────────────────────────────
  // Host detection and the desktop shell (Tauri IPC, updater, deep links).
  platform: {
    layer: "infra",
    public: [
      "ipc.ts",
      "is-mac.ts",
      "nav-download-studio.tsx",
      "platform.ts",
      "use-deep-link.ts",
      "use-updater.ts",
    ],
  },
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
