/**
 * Architecture guard: resolves a module specifier to a file under the source root.
 *
 * Dependency-free (only `node:path`) so both the bun:test guard and the oxlint plugin, which Node
 * loads with plain type stripping, can share it.
 */
import { posix } from "node:path";

/** Tried in order when a specifier has no extension (Vite/TS "Bundler" resolution). */
const RESOLVE_SUFFIXES = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".json", ".css"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

/**
 * Resolves a specifier written in `importer` (both relative to the source root) to a file under
 * the source root. `@/x` is `<root>/x`, as in apps/web/tsconfig.json. Returns `null` for bare
 * packages and for anything outside the root. A path that matches no file on disk (for example
 * wasm-pack output that has not been built) is returned unresolved, so it still belongs to a folder.
 */
export function resolveSpecifier(
  importer: string,
  specifier: string,
  files: ReadonlySet<string> | ((path: string) => boolean),
): string | null {
  const exists = typeof files === "function" ? files : (path: string) => files.has(path);
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
  return candidates.find(exists) ?? path;
}
