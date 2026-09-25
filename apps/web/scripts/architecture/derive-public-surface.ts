/**
 * Derives the `public` lists for VERTICALS from the imports that exist today, and prints the
 * cross-vertical dependency counts (to spot cycles between verticals).
 *
 *   bun apps/web/scripts/architecture/derive-public-surface.ts [--src <dir>]
 *
 * It groups files by their top-level folder under src/, whether or not VERTICALS knows that
 * folder yet. A file is listed as public when a file outside its folder imports it: static,
 * `export … from`, dynamic, side-effect, `mock.module`, and type-only imports all count, the
 * same as in the guard. Importers under a `generated/` folder are skipped.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT, isGenerated, verticalOf } from "./engine";
import { buildImportGraph } from "./import-graph";
import { VERTICALS } from "./verticals";

const srcFlag = process.argv.indexOf("--src");
const srcRoot =
  srcFlag !== -1 && process.argv[srcFlag + 1]
    ? resolve(process.argv[srcFlag + 1] as string)
    : fileURLToPath(new URL("../../src", import.meta.url));

const isTest = (file: string): boolean => /\.(test|bench)\.[cm]?[jt]sx?$/.test(file);

interface Usage {
  importers: Set<string>;
  runtime: boolean; // at least one import that is not type-only
}
interface Edge {
  imports: number;
  typeOnly: number;
  files: Set<string>;
}

const graph = buildImportGraph(srcRoot);
/** target vertical → target file → usage */
const surface = new Map<string, Map<string, Usage>>();
/** "from\0to" → edge */
const edges = new Map<string, Edge>();

for (const [importer, imports] of graph) {
  if (isGenerated(importer)) continue;
  const from = verticalOf(importer);
  for (const imp of imports) {
    if (imp.target === null) continue;
    const to = verticalOf(imp.target);
    if (to === from) continue;

    const key = `${from}\0${to}`;
    const edge = edges.get(key) ?? { imports: 0, typeOnly: 0, files: new Set<string>() };
    edge.imports += 1;
    if (imp.typeOnly) edge.typeOnly += 1;
    edge.files.add(importer);
    edges.set(key, edge);

    const files = surface.get(to) ?? new Map<string, Usage>();
    const usage = files.get(imp.target) ?? { importers: new Set<string>(), runtime: false };
    usage.importers.add(importer);
    usage.runtime ||= !imp.typeOnly;
    files.set(imp.target, usage);
    surface.set(to, files);
  }
}

const out: string[] = [];
const crossImports = [...edges.values()].reduce((sum, e) => sum + e.imports, 0);
out.push(
  `// Public surface derived from ${srcRoot}`,
  `// ${graph.size} files, ${crossImports} cross-vertical imports. Paste into VERTICALS in`,
  `// apps/web/scripts/architecture/verticals.ts. "tests only" = no production file imports it;`,
  `// consider fixing the test instead of widening the surface.`,
  "",
);

const isTop = (vertical: string): boolean =>
  vertical === ROOT || VERTICALS[vertical]?.layer === "top";

for (const vertical of [...surface.keys()].sort()) {
  const files = surface.get(vertical);
  if (!files) continue;
  if (isTop(vertical)) {
    // Top-layer files need no public list; only imports from below them are worth printing.
    const fromBelow = [...files]
      .map(([file, usage]) => [file, [...usage.importers].filter((i) => !isTop(verticalOf(i)))] as const)
      .filter(([, importers]) => importers.length > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    out.push(
      `// ${vertical}: top layer, needs no public list. ${fromBelow.length ? "Imported from below (routes-are-top violations):" : "Imported only by the top layer."}`,
    );
    for (const [file, importers] of fromBelow) out.push(`//   ${file} <- ${importers.sort().join(", ")}`);
    out.push("");
    continue;
  }
  const declared = VERTICALS[vertical]?.public;
  const note =
    declared === undefined
      ? " // not in VERTICALS yet"
      : declared.includes("*")
        ? ' // VERTICALS already declares "*"; listed for information'
        : "";
  out.push(`${vertical}: {${note}`, "  public: [");
  for (const [file, usage] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const byVertical = new Map<string, number>();
    for (const importer of usage.importers) {
      const v = verticalOf(importer);
      byVertical.set(v, (byVertical.get(v) ?? 0) + 1);
    }
    const from = [...byVertical]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([v, n]) => `${v} ×${n}`)
      .join(", ");
    const tags = [
      [...usage.importers].every(isTest) ? "tests only" : "",
      usage.runtime ? "" : "type-only",
    ].filter(Boolean);
    const n = usage.importers.size;
    const inner = file.slice(vertical.length + 1);
    out.push(
      `    "${inner}", // ${n} importer${n === 1 ? "" : "s"}: ${from}${tags.length ? ` (${tags.join(", ")})` : ""}`,
    );
  }
  out.push("  ],", "},", "");
}

// ── Cross-vertical dependencies ──────────────────────────────────────────────────────────
const sortedEdges = [...edges].sort(([a], [b]) => a.localeCompare(b));
const width = Math.max(...sortedEdges.map(([key]) => key.replace("\0", " -> ").length), 0);
out.push(
  "// Cross-vertical dependencies: A -> B  imports (type-only)  [distinct importing files]",
);
/** Edges inside the top layer (routeTree.gen.ts <-> routes/) are by design, not cycles to fix. */
const withinTop = (key: string): boolean => key.split("\0").every(isTop);
for (const [key, edge] of sortedEdges) {
  const label = key.replace("\0", " -> ").padEnd(width);
  const reverse = key.split("\0").reverse().join("\0");
  const mutual = edges.has(reverse) && !withinTop(key) ? "  <-> mutual" : "";
  const files = edge.files.size;
  out.push(
    `//   ${label}  ${String(edge.imports).padStart(4)} (${edge.typeOnly} type-only)  [${files} file${files === 1 ? "" : "s"}]${mutual}`,
  );
}

/** Tarjan's SCC over the vertical graph; returns the groups with more than one vertical. */
function cycles(includeTypeOnly: boolean): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const [key, edge] of edges) {
    if (withinTop(key)) continue;
    if (!includeTypeOnly && edge.imports === edge.typeOnly) continue;
    const [from = "", to = ""] = key.split("\0");
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
    if (!adjacency.has(to)) adjacency.set(to, []);
  }
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const connect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) groups.push(group.sort());
    }
  };
  for (const v of [...adjacency.keys()].sort()) if (!index.has(v)) connect(v);
  return groups;
}

out.push("", "// Cycles between verticals (strongly connected groups):");
const all = cycles(true);
const runtime = cycles(false);
out.push(
  `//   all imports:           ${all.length ? all.map((g) => `{${g.join(", ")}}`).join("  ") : "none"}`,
  `//   runtime imports only:  ${runtime.length ? runtime.map((g) => `{${g.join(", ")}}`).join("  ") : "none"}`,
);

console.log(out.join("\n"));
