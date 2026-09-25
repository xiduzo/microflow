/**
 * Architecture guard: apps/web/src is organised in verticals, and the VERTICALS table in
 * apps/web/scripts/architecture/verticals.ts says what each vertical may import from the others.
 *
 * The first block unit-tests the rule engine on small in-memory import graphs (one passing and
 * one failing fixture per rule). The last test runs the engine over the real tree. When it fails,
 * each violation names the importing file, the specifier, the resolved target, the rule, and the fix.
 */
import { describe, expect, test } from "bun:test";

import {
  checkArchitecture,
  formatReport,
  type ArchitectureConfig,
  type Import,
} from "../scripts/architecture/engine";
import {
  buildImportGraph,
  extractImports,
  resolveSpecifier,
} from "../scripts/architecture/import-graph";
import { ARCHITECTURE } from "../scripts/architecture/verticals";

const CONFIG: ArchitectureConfig = {
  configPath: "verticals.ts",
  rootFiles: ["main.tsx", "index.css"],
  verticals: {
    routes: { layer: "top", public: [] },
    nodes: {
      public: ["catalog.ts", "node-types.ts", "container/*"],
      restricted: {
        "node-types.ts": { allowedImporters: ["editor"], reason: "React node map." },
      },
    },
    editor: { public: ["canvas.tsx"] },
    runtime: { public: ["index.ts"] },
    platform: { layer: "infra", public: ["ipc.ts"] },
    lib: { layer: "infra", public: ["*"] },
  },
};

/** An import of `target` written as `@/<target>`. */
function imp(target: string, extra: Partial<Import> = {}): Import {
  return { specifier: `@/${target}`, target, kind: "static", typeOnly: false, line: 3, ...extra };
}

function check(files: Record<string, Import[]>) {
  return checkArchitecture(new Map(Object.entries(files)), CONFIG);
}

describe("rule engine", () => {
  describe("public-surface", () => {
    test("passes for public files, glob entries, and imports inside a vertical", () => {
      expect(
        check({
          "editor/canvas.tsx": [
            imp("runtime/index.ts"),
            imp("nodes/container/deep/handle.tsx"),
            imp("editor/internal.ts"),
          ],
          "editor/internal.ts": [],
          "runtime/index.ts": [],
          "nodes/container/deep/handle.tsx": [],
        }),
      ).toEqual([]);
    });

    test("fails for an internal file, type-only imports included", () => {
      const violations = check({
        "editor/canvas.tsx": [imp("runtime/flow-reactor.ts", { typeOnly: true })],
        "runtime/flow-reactor.ts": [],
      });
      expect(violations.map((v) => v.rule)).toEqual(["public-surface"]);
      const [v] = violations;
      expect(v?.message).toContain('editor/canvas.tsx:3 imports "@/runtime/flow-reactor.ts"');
      expect(v?.message).toContain("resolves to runtime/flow-reactor.ts");
      expect(v?.message).toContain('add "flow-reactor.ts" to VERTICALS.runtime.public');
    });
  });

  describe("routes-are-top", () => {
    test("passes when routes and root files import verticals and each other", () => {
      expect(
        check({
          "main.tsx": [imp("routes/flow.tsx"), imp("lib/trpc.ts")],
          "routes/flow.tsx": [imp("editor/canvas.tsx"), { ...imp("index.css"), specifier: "../index.css" }],
          "editor/canvas.tsx": [],
          "lib/trpc.ts": [],
          "index.css": [],
        }),
      ).toEqual([]);
    });

    test("fails when a vertical imports routes/ or a root file", () => {
      const violations = check({
        "editor/canvas.tsx": [imp("routes/flow.tsx"), imp("main.tsx")],
        "routes/flow.tsx": [],
        "main.tsx": [],
      });
      expect(violations.map((v) => [v.rule, v.target])).toEqual([
        ["routes-are-top", "routes/flow.tsx"],
        ["routes-are-top", "main.tsx"],
      ]);
      expect(violations[0]?.message).toContain("move the code editor/canvas.tsx needs out of routes/flow.tsx");
    });
  });

  describe("infra-layer", () => {
    test("passes when infrastructure imports only infrastructure", () => {
      expect(
        check({ "lib/trpc.ts": [imp("platform/ipc.ts")], "platform/ipc.ts": [imp("lib/uid.ts")], "lib/uid.ts": [] }),
      ).toEqual([]);
    });

    test("fails when infrastructure imports a feature vertical, even its public surface", () => {
      const violations = check({
        "lib/trpc.ts": [imp("runtime/index.ts", { typeOnly: true })],
        "runtime/index.ts": [],
      });
      expect(violations.map((v) => v.rule)).toEqual(["infra-layer"]);
      expect(violations[0]?.message).toContain('"lib" is infrastructure and may import only platform, lib');
    });
  });

  describe("restricted-file", () => {
    test("passes for allowed importers, and for type-only imports from anyone", () => {
      expect(
        check({
          "editor/canvas.tsx": [imp("nodes/node-types.ts")],
          "runtime/index.ts": [imp("nodes/node-types.ts", { typeOnly: true, kind: "type-query" })],
          "nodes/node-types.ts": [],
        }),
      ).toEqual([]);
    });

    test("fails for a runtime import from a vertical that is not allowed", () => {
      const violations = check({
        "runtime/index.ts": [imp("nodes/node-types.ts", { kind: "dynamic" })],
        "nodes/node-types.ts": [],
      });
      expect(violations.map((v) => v.rule)).toEqual(["restricted-file"]);
      expect(violations[0]?.message).toContain("only these verticals may import at runtime: nodes, editor");
      expect(violations[0]?.message).toContain("why: React node map.");
      expect(violations[0]?.message).toContain(
        'add "runtime" to VERTICALS.nodes.restricted["node-types.ts"].allowedImporters',
      );
    });
  });

  describe("unknown-vertical", () => {
    test("passes when every folder and root file is declared", () => {
      expect(check({ "main.tsx": [], "index.css": [], "lib/uid.ts": [] })).toEqual([]);
    });

    test("fails once per unknown folder or root file, not once per import", () => {
      const violations = check({
        "components/a.tsx": [imp("runtime/flow-reactor.ts")],
        "components/b.tsx": [],
        "stray.ts": [],
        "editor/canvas.tsx": [imp("components/a.tsx")],
        "runtime/flow-reactor.ts": [],
      });
      expect(violations.map((v) => [v.rule, v.importer])).toEqual([
        ["unknown-vertical", "stray.ts"],
        ["unknown-vertical", "components/"],
      ]);
      expect(violations[1]?.message).toContain("src/components/ (2 files) is not a known vertical");
      expect(violations[1]?.message).toContain('add "components" to VERTICALS in verticals.ts');
      expect(violations[0]?.message).toContain('add "stray.ts" to ROOT_FILES');
    });
  });

  test("skips importers under generated/, bare packages, and paths outside src/", () => {
    expect(
      check({
        "runtime/generated/glue.js": [imp("editor/internal.ts")],
        "editor/canvas.tsx": [{ ...imp("x"), specifier: "react", target: null }],
        "editor/internal.ts": [],
      }),
    ).toEqual([]);
  });

  test("reports one violation per importer and target, however often it is imported", () => {
    const violations = check({
      "editor/canvas.tsx": [imp("runtime/a.ts"), imp("runtime/a.ts", { kind: "mock", line: 9 })],
      "runtime/a.ts": [],
    });
    expect(violations).toHaveLength(1);
  });
});

describe("import extraction", () => {
  test("finds every import form, with its kind and whether it is type-only", () => {
    const source = `
      import {
        a,
        b,
      } from "@/multi/line";
      import type { T } from "./types";
      import { type U } from "./kept-at-runtime";
      import "./side-effect.css";
      export * from "../re/export";
      export type { V } from "./type-reexport";
      // import { commented } from "./not-an-import";
      const s = 'import x from "./in-a-string"';
      type W = import("./type-query").W;
      mock.module("@/mocked", () => ({}));
      const lazy = await import("./lazy");
    `;
    expect(extractImports("x.tsx", source).map((i) => [i.specifier, i.kind, i.typeOnly])).toEqual([
      ["@/multi/line", "static", false],
      ["./types", "static", true],
      ["./kept-at-runtime", "static", false],
      ["./side-effect.css", "side-effect", false],
      ["../re/export", "re-export", false],
      ["./type-reexport", "re-export", true],
      ["./type-query", "type-query", true],
      ["@/mocked", "mock", false],
      ["./lazy", "dynamic", false],
    ]);
    expect(extractImports("x.tsx", source)[0]?.line).toBe(5);
  });

  test("resolves @/ and relative specifiers to files under src/", () => {
    const files = new Set(["session/index.ts", "lib/uid.ts", "routes/code.lazy.tsx"]);
    expect(resolveSpecifier("routes/a.tsx", "@/session", files)).toBe("session/index.ts");
    expect(resolveSpecifier("session/a.ts", "../lib/uid", files)).toBe("lib/uid.ts");
    expect(resolveSpecifier("routeTree.gen.ts", "./routes/code.lazy", files)).toBe("routes/code.lazy.tsx");
    expect(resolveSpecifier("lib/wasm.ts", "./generated/x_bg.wasm?url", files)).toBe(
      "lib/generated/x_bg.wasm",
    );
    expect(resolveSpecifier("lib/a.ts", "react", files)).toBeNull();
    expect(resolveSpecifier("main.tsx", "../scripts/x", files)).toBeNull();
  });
});

test("apps/web/src follows the VERTICALS architecture", () => {
  const violations = checkArchitecture(buildImportGraph(import.meta.dir), ARCHITECTURE);
  if (violations.length > 0) throw new Error(formatReport(violations, ARCHITECTURE));
});
