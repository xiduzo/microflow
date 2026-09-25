// oxlint JS plugin: the architecture guard as lint rules, so a boundary break shows up in the
// editor and in `bunx oxlint` (CI), not only in `bun test src/architecture.test.ts`.
//
// It runs the SAME engine and VERTICALS table as the bun:test guard (ADR-0027); nothing about the
// rules lives here. The engine files are TypeScript without non-erasable syntax, and Node (>= 22.18)
// loads them by stripping types, which is why this file imports them with their `.ts` extension
// and is itself plain JS (tsc never sees it).
//
// Rules (enabled for apps/web/src in the repo's .oxlintrc.json):
//   microflow/vertical-boundaries  the five guard rules, reported on the offending import
//   microflow/cross-vertical-alias an import into another vertical uses the `@/` alias, never
//                                  `../`, so every boundary crossing is visible in the import
//                                  list. Autofixable.
import { existsSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { checkArchitecture, verticalOf } from "./engine.ts";
import { resolveSpecifier } from "./resolve.ts";
import { ARCHITECTURE } from "./verticals.ts";

const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));

/** The linted file relative to apps/web/src, `/`-separated; `null` outside it. */
function srcRelative(filename) {
  const rel = relative(SRC_ROOT, filename);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  return rel.split(sep).join("/");
}

function isFile(srcPath) {
  const abs = SRC_ROOT + srcPath;
  return existsSync(abs) && statSync(abs).isFile();
}

function stringLiteral(node) {
  return node && node.type === "Literal" && typeof node.value === "string" ? node : null;
}

/**
 * Calls `visit(literal, kind, typeOnly)` for every module specifier, with the same kinds and
 * type-only semantics as scripts/architecture/import-graph.ts.
 */
function importVisitors(visit) {
  return {
    ImportDeclaration(node) {
      const kind = node.specifiers.length === 0 ? "side-effect" : "static";
      visit(stringLiteral(node.source), kind, node.importKind === "type");
    },
    ExportNamedDeclaration(node) {
      if (node.source) visit(stringLiteral(node.source), "re-export", node.exportKind === "type");
    },
    ExportAllDeclaration(node) {
      visit(stringLiteral(node.source), "re-export", node.exportKind === "type");
    },
    ImportExpression(node) {
      visit(stringLiteral(node.source), "dynamic", false);
    },
    TSImportType(node) {
      const literal = node.source ?? node.argument?.literal ?? node.argument;
      visit(stringLiteral(literal), "type-query", true);
    },
    CallExpression(node) {
      const callee = node.callee;
      if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "mock" &&
        callee.property.type === "Identifier" &&
        callee.property.name === "module"
      ) {
        visit(stringLiteral(node.arguments[0]), "mock", false);
      }
    },
  };
}

const verticalBoundaries = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Imports respect the vertical layout of apps/web/src (ADR-0027): public surfaces, routes on top, the infra layer, restricted files, known verticals.",
    },
  },
  create(context) {
    const file = srcRelative(context.filename);
    if (!file) return {};
    const imports = [];
    const nodesByLine = new Map();
    let program = null;
    return {
      Program(node) {
        program = node;
      },
      ...importVisitors((literal, kind, typeOnly) => {
        if (!literal) return;
        const line = literal.loc?.start.line ?? 0;
        imports.push({
          specifier: literal.value,
          target: resolveSpecifier(file, literal.value, isFile),
          kind,
          typeOnly,
          line,
        });
        if (!nodesByLine.has(line)) nodesByLine.set(line, literal);
      }),
      "Program:exit"() {
        const violations = checkArchitecture(new Map([[file, imports]]), ARCHITECTURE);
        for (const violation of violations) {
          const node = (violation.line && nodesByLine.get(violation.line)) || program;
          context.report({ node, message: violation.message });
        }
      },
    };
  },
};

const crossVerticalAlias = {
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: {
      description:
        "An import into another vertical of apps/web/src uses the `@/` alias, not a relative path.",
    },
  },
  create(context) {
    const file = srcRelative(context.filename);
    if (!file) return {};
    const own = verticalOf(file);
    return importVisitors((literal) => {
      const specifier = literal?.value;
      if (!specifier || !(specifier.startsWith("./") || specifier.startsWith("../"))) return;
      const target = resolveSpecifier(file, specifier, isFile);
      if (!target || verticalOf(target) === own) return;
      const query = specifier.match(/[?#].*$/)?.[0] ?? "";
      const bare = specifier.slice(0, specifier.length - query.length);
      const hadExtension = /\.[a-z]+$/i.test(bare.split("/").pop() ?? "");
      let path = target;
      if (!hadExtension) path = path.replace(/\/index\.(ts|tsx|js|jsx)$/, "").replace(/\.(d\.ts|tsx?|jsx?)$/, "");
      const aliased = `@/${path}${query}`;
      const quote = literal.raw?.[0] ?? '"';
      context.report({
        node: literal,
        message: `"${specifier}" crosses from ${own}/ into ${verticalOf(target)}/; import it as "${aliased}" so the boundary crossing is visible.`,
        fix: (fixer) => fixer.replaceText(literal, `${quote}${aliased}${quote}`),
      });
    });
  },
};

export default {
  meta: { name: "microflow" },
  rules: {
    "vertical-boundaries": verticalBoundaries,
    "cross-vertical-alias": crossVerticalAlias,
  },
};
