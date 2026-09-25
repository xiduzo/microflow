/**
 * Architecture guard: the pure rule engine.
 *
 * Input: an import graph (every source file under apps/web/src mapped to its imports, paths
 * relative to src/ with `/` separators) and an {@link ArchitectureConfig} (the VERTICALS table
 * in ./verticals.ts). Output: the list of violations. There is no I/O in this file, so each rule
 * can be unit-tested with small in-memory graphs (see src/architecture.test.ts). The graph for the
 * real tree comes from ./import-graph.ts.
 */

/** How the import appears in the source. */
export type ImportKind =
  | "static" // import x from "…" / import { x } from "…"
  | "re-export" // export … from "…"
  | "side-effect" // import "…"
  | "dynamic" // import("…")
  | "type-query" // type T = import("…").T
  | "mock"; // mock.module("…") in a bun:test file

export interface Import {
  /** The specifier as written, e.g. `"@/session"` or `"../lib/uid"`. */
  specifier: string;
  /**
   * The resolved file, relative to src/ (`session/index.ts`). `null` for a bare package
   * specifier or anything that resolves outside src/. The engine ignores `null` targets.
   */
  target: string | null;
  kind: ImportKind;
  /**
   * True when the compiler erases the import: `import type …`, `export type … from`, and
   * `import("…").T` type queries. `import { type A } from "…"` is NOT type-only: under
   * `verbatimModuleSyntax` it is emitted as `import {} from "…"`, so the module still loads.
   */
  typeOnly: boolean;
  /** 1-based line of the import in the importing file. */
  line: number;
}

/** Every source file under src/ → its imports. Files without imports still appear (empty list). */
export type ImportGraph = ReadonlyMap<string, readonly Import[]>;

/**
 * - `feature` (default): a domain vertical.
 * - `infra`: app-wide infrastructure. It may import only other infra verticals.
 * - `top`: the composition layer (`routes/`, and the root files). No other layer may import it.
 */
export type Layer = "feature" | "infra" | "top";

export interface RestrictedFile {
  /** Verticals that may import the file at runtime. The owning vertical is always allowed. */
  allowedImporters: readonly string[];
  /** Why the file is restricted, and what to use instead. Quoted in the violation message. */
  reason: string;
}

export interface VerticalSpec {
  /**
   * The files other verticals may import, relative to the vertical's folder. `*` matches any run
   * of characters, `/` included, the same as a subpath pattern in a package.json `exports` map.
   * Everything that no entry matches is internal.
   */
  public: readonly string[];
  layer?: Layer;
  /**
   * Files (same pattern syntax as `public`) that only some verticals may import at runtime.
   * `import type` is exempt, because it is erased at compile time.
   */
  restricted?: Readonly<Record<string, RestrictedFile>>;
}

export interface ArchitectureConfig {
  /** Top-level folder under src/ → its spec. */
  verticals: Readonly<Record<string, VerticalSpec>>;
  /** Files allowed directly in src/ (not in a folder). They belong to the `top` layer. */
  rootFiles: readonly string[];
  /** Where the config lives, repo-relative. Quoted in the fix hints. */
  configPath: string;
}

export type RuleId =
  | "unknown-vertical"
  | "routes-are-top"
  | "infra-layer"
  | "restricted-file"
  | "public-surface";

/** Rule order in reports. Each import edge reports at most one rule: the first one it breaks. */
export const RULES: readonly RuleId[] = [
  "unknown-vertical",
  "routes-are-top",
  "infra-layer",
  "restricted-file",
  "public-surface",
];

export interface Violation {
  rule: RuleId;
  /** The importing file. For `unknown-vertical`, the unknown folder (`components/`) or root file. */
  importer: string;
  specifier?: string;
  target?: string;
  line?: number;
  /** Multi-line and self-contained: what broke, which rule, and how to fix it. */
  message: string;
}

/** The pseudo-vertical that holds the files directly in src/. */
export const ROOT = "<root>";

export function verticalOf(file: string): string {
  const slash = file.indexOf("/");
  return slash === -1 ? ROOT : file.slice(0, slash);
}

const patternCache = new Map<string, RegExp>();

/** `*` matches any run of characters, including `/` (package.json `exports` semantics). */
export function matchesPattern(path: string, pattern: string): boolean {
  let re = patternCache.get(pattern);
  if (!re) {
    const body = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    re = new RegExp(`^${body}$`);
    patternCache.set(pattern, re);
  }
  return re.test(path);
}

/** Files under a `generated/` folder (wasm-pack output) are never checked as importers. */
export function isGenerated(file: string): boolean {
  return file.split("/").slice(0, -1).includes("generated");
}

export function checkArchitecture(graph: ImportGraph, config: ArchitectureConfig): Violation[] {
  const { verticals, rootFiles, configPath } = config;
  const violations: Violation[] = [];
  const files = [...graph.keys()].sort();

  const isKnownFile = (file: string): boolean => {
    const v = verticalOf(file);
    return v === ROOT ? rootFiles.includes(file) : Object.hasOwn(verticals, v);
  };
  const layerOf = (vertical: string): Layer =>
    vertical === ROOT ? "top" : (verticals[vertical]?.layer ?? "feature");
  const describe = (vertical: string): string =>
    vertical === ROOT ? "the src/ root files" : `vertical "${vertical}"`;

  // Unknown top-level entries: once per folder or root file, not once per import.
  const unknownFolders = new Map<string, number>();
  for (const file of files) {
    if (isKnownFile(file)) continue;
    const v = verticalOf(file);
    if (v === ROOT) {
      violations.push({
        rule: "unknown-vertical",
        importer: file,
        message: [
          `unknown-vertical: src/${file} is a file directly in src/ that ROOT_FILES does not list.`,
          `  Every top-level entry under apps/web/src must be declared, so new code has to pick a home.`,
          `  fix: move it into a vertical, or add "${file}" to ROOT_FILES in ${configPath}.`,
        ].join("\n"),
      });
    } else {
      unknownFolders.set(v, (unknownFolders.get(v) ?? 0) + 1);
    }
  }
  for (const [folder, count] of unknownFolders) {
    violations.push({
      rule: "unknown-vertical",
      importer: `${folder}/`,
      message: [
        `unknown-vertical: src/${folder}/ (${count} file${count === 1 ? "" : "s"}) is not a known vertical.`,
        `  Every top-level entry under apps/web/src must be declared, so new code has to pick a home.`,
        `  fix: move its files into an existing vertical, or add "${folder}" to VERTICALS in ${configPath}.`,
      ].join("\n"),
    });
  }

  const seen = new Set<string>();
  const report = (v: Omit<Violation, "message">, lines: string[]): void => {
    const key = `${v.rule}|${v.importer}|${v.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ ...v, message: lines.join("\n") });
  };

  for (const importer of files) {
    if (isGenerated(importer) || !isKnownFile(importer)) continue;
    const from = verticalOf(importer);
    const fromLayer = layerOf(from);

    for (const imp of graph.get(importer) ?? []) {
      const target = imp.target;
      // Bare packages, paths outside src/, and unknown folders (already reported above).
      if (target === null || !isKnownFile(target)) continue;
      const to = verticalOf(target);
      if (to === from) continue;
      const toLayer = layerOf(to);
      const head = `${importer}:${imp.line} imports "${imp.specifier}"`;
      const base = { importer, specifier: imp.specifier, target, line: imp.line };

      if (toLayer === "top") {
        if (fromLayer !== "top") {
          report({ ...base, rule: "routes-are-top" }, [
            `routes-are-top: ${head}`,
            `  resolves to ${target}, which belongs to ${describe(to)} (the top layer).`,
            `  routes/ and the src/ root files compose the verticals; no vertical may import them.`,
            `  fix: move the code ${importer} needs out of ${target} into a vertical, and import it from both places.`,
          ]);
        }
        continue;
      }

      if (fromLayer === "infra" && toLayer !== "infra") {
        const infra = Object.keys(verticals).filter((v) => verticals[v]?.layer === "infra");
        report({ ...base, rule: "infra-layer" }, [
          `infra-layer: ${head}`,
          `  resolves to ${target}, in ${describe(to)}. "${from}" is infrastructure and may import only ${infra.join(", ")}.`,
          `  fix: move ${importer} into ${to}/ (or another vertical) if it is domain code; or move what it needs from ${to}/ into ${from}/; or invert the dependency (take it as a parameter).`,
        ]);
        continue;
      }

      const spec = verticals[to];
      if (!spec) continue;
      const inner = target.slice(to.length + 1);

      if (!imp.typeOnly) {
        const restriction = Object.entries(spec.restricted ?? {}).find(([pattern]) =>
          matchesPattern(inner, pattern),
        );
        if (restriction && !restriction[1].allowedImporters.includes(from)) {
          const [pattern, rule] = restriction;
          const allowed = [to, ...rule.allowedImporters].join(", ");
          report({ ...base, rule: "restricted-file" }, [
            `restricted-file: ${head}`,
            `  resolves to ${target}, which only these verticals may import at runtime: ${allowed}.`,
            `  why: ${rule.reason}`,
            `  fix: use \`import type\` if ${importer} needs only types; otherwise import what it needs from another file, or add "${from}" to VERTICALS.${to}.restricted["${pattern}"].allowedImporters in ${configPath}.`,
          ]);
          continue;
        }
      }

      if (!spec.public.some((pattern) => matchesPattern(inner, pattern))) {
        const surface = spec.public.length === 0 ? "none declared yet" : spec.public.join(", ");
        // Routes stay thin, so "move it into the importer" is only advice for a feature vertical.
        const move =
          fromLayer === "feature" ? `; or move the code into ${from}/ if only ${from} uses it` : "";
        report({ ...base, rule: "public-surface" }, [
          `public-surface: ${head}${imp.typeOnly ? " (type-only imports count too)" : ""}`,
          `  resolves to ${target}, which is internal to ${describe(to)} (public: ${surface}).`,
          `  fix: import it through one of ${to}'s public files; or, if other verticals should use it, add "${inner}" to VERTICALS.${to}.public in ${configPath}${move}.`,
        ]);
      }
    }
  }

  return violations;
}

/** One readable block for a failing test: a per-rule summary, then every violation grouped by rule. */
export function formatReport(violations: readonly Violation[], config: ArchitectureConfig): string {
  if (violations.length === 0) return "";
  const byRule = new Map<RuleId, Violation[]>();
  for (const v of violations) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
  const ordered = RULES.filter((rule) => byRule.has(rule));
  const summary = ordered.map((rule) => `${rule}: ${byRule.get(rule)?.length}`).join(", ");
  const sections = ordered.map((rule) => {
    const items = byRule.get(rule) ?? [];
    return [`── ${rule} (${items.length}) ──`, ...items.map((v) => v.message)].join("\n\n");
  });
  return [
    `Architecture guard: ${violations.length} violation${violations.length === 1 ? "" : "s"} (${summary}).`,
    `The VERTICALS table and the rules live in ${config.configPath}.`,
    ...sections,
  ].join("\n\n");
}
