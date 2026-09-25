/**
 * Architecture guard: builds the import graph of a source tree.
 *
 * Parses every source file with the TypeScript compiler API (syntax only, no type checking),
 * collects each module specifier, and resolves `@/…` and relative specifiers to files under the
 * source root. Bare package specifiers (`react`, `node:fs`, `bun:test`) resolve to `null`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
import ts from "typescript";

import { isGenerated, type Import, type ImportGraph, type ImportKind } from "./engine";

/** Files that become graph nodes. Only the script ones are parsed for imports. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css"]);
const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};
/** Tried in order when a specifier has no extension (Vite/TS "Bundler" resolution). */
const RESOLVE_SUFFIXES = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".json", ".css"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

export type RawImport = Omit<Import, "target">;

/** Every module specifier in one file, in source order. Comments and strings are never matched. */
export function extractImports(fileName: string, text: string): RawImport[] {
  const kind = SCRIPT_KINDS[extname(fileName)] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const found: RawImport[] = [];

  const add = (literal: ts.Node, importKind: ImportKind, typeOnly: boolean): void => {
    if (!ts.isStringLiteralLike(literal)) return; // import(someVariable): not statically known
    const line = sf.getLineAndCharacterOfPosition(literal.getStart(sf)).line + 1;
    found.push({ specifier: literal.text, kind: importKind, typeOnly, line });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) add(node.moduleSpecifier, "side-effect", false);
      else add(node.moduleSpecifier, "static", clause.phaseModifier === ts.SyntaxKind.TypeKeyword);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, "re-export", node.isTypeOnly);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, "static", node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, "type-query", true);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0], "dynamic", false);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "mock" &&
        callee.name.text === "module"
      ) {
        add(node.arguments[0], "mock", false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Resolves a specifier written in `importer` (both relative to the source root) to a file under
 * the source root. `@/x` is `<root>/x`, as in apps/web/tsconfig.json. Returns `null` for bare
 * packages and for anything outside the root. A path that matches no file on disk (for example
 * wasm-pack output that has not been built) is returned unresolved, so it still belongs to a folder.
 */
export function resolveSpecifier(
  importer: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | null {
  const bare = specifier.replace(/[?#].*$/, ""); // Vite suffixes: ?url, ?raw, ?worker
  let path: string;
  if (bare.startsWith("@/")) path = posix.normalize(bare.slice(2));
  else if (bare.startsWith("./") || bare.startsWith("../") || bare === "." || bare === "..")
    path = posix.normalize(posix.join(posix.dirname(importer), bare));
  else return null;
  if (path === "." || path.startsWith("../") || path === "..") return null;
  path = path.replace(/\/$/, "");

  const candidates = [
    path,
    ...RESOLVE_SUFFIXES.map((suffix) => path + suffix),
    ...INDEX_FILES.map((index) => `${path}/${index}`),
  ];
  // TS-style ESM specifiers: "./foo.js" may mean foo.ts / foo.tsx.
  if (/\.(m|c)?jsx?$/.test(path)) {
    const stem = path.replace(/\.(m|c)?jsx?$/, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  return candidates.find((candidate) => files.has(candidate)) ?? path;
}

/** All files under `root`, relative and `/`-separated. Skips dotfiles and node_modules. */
function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** The import graph of every source file under `srcRoot` (for the guard: apps/web/src). */
export function buildImportGraph(srcRoot: string): ImportGraph {
  const allFiles = walk(srcRoot);
  const fileSet = new Set(allFiles);
  const graph = new Map<string, Import[]>();
  for (const file of allFiles.sort()) {
    const ext = extname(file);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (ext === ".css" || isGenerated(file)) {
      graph.set(file, []);
      continue;
    }
    const raw = extractImports(file, readFileSync(join(srcRoot, file), "utf8"));
    graph.set(
      file,
      raw.map((imp) => ({ ...imp, target: resolveSpecifier(file, imp.specifier, fileSet) })),
    );
  }
  return graph;
}
