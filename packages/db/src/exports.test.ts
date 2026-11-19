// What `@microflow/db` lets another package import: the entries `package.json`
// names, and nothing else. `./testing` is one of them, and it is the test
// process's database (PGlite, the migrations applied at import, bound as the
// process's `db`), so only a test file may import it.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const PACKAGE_ROOT = new URL("../", import.meta.url).pathname;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const exported = (
  JSON.parse(readFileSync(`${PACKAGE_ROOT}package.json`, "utf8")) as {
    exports: Record<string, { default: string }>;
  }
).exports;

/** Every `@microflow/db/<subpath>` a source text imports, as `./<subpath>`. */
function dbSubpathImports(source: string): string[] {
  const imports = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']@microflow\/db\/([^"']+)["']/g;
  return [...source.matchAll(imports)].map((match) => `./${match[1]}`);
}

/** The file an export entry serves `subpath` from, or undefined when no entry does. */
function served(subpath: string): string | undefined {
  for (const [entry, { default: target }] of Object.entries(exported)) {
    if (entry === subpath) return target;
    const star = entry.indexOf("*");
    if (star < 0) continue;
    const [before, after] = [entry.slice(0, star), entry.slice(star + 1)];
    if (!subpath.startsWith(before) || !subpath.endsWith(after)) continue;
    const middle = subpath.slice(before.length, subpath.length - after.length);
    if (middle.length > 0) return target.replace("*", middle);
  }
  return undefined;
}

const isTestFile = (path: string) => /\.test\.[cm]?tsx?$/.test(path);

/** The repo's TypeScript sources: tracked, or new and not ignored. */
function sources(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "apps", "packages"],
    { cwd: REPO_ROOT },
  );
  expect(listed.exitCode).toBe(0);
  return listed.stdout
    .toString()
    .split("\n")
    .filter((path) => /\.[cm]?tsx?$/.test(path) && existsSync(`${REPO_ROOT}${path}`));
}

describe("the import scan", () => {
  test("finds static, type-only, side-effect, dynamic and required imports of a subpath", () => {
    expect(
      dbSubpathImports(`
        import { useTestDb } from "@microflow/db/testing";
        import type { InviteNotice } from '@microflow/db/flow-invitation';
        import "@microflow/db/testing";
        const lazy = await import("@microflow/db/schema/flow");
        const old = require("@microflow/db/schema/auth");
      `),
    ).toEqual(["./testing", "./flow-invitation", "./testing", "./schema/flow", "./schema/auth"]);
  });

  test("leaves the package root and a mention in a string alone", () => {
    expect(
      dbSubpathImports(`
        import { db } from "@microflow/db";
        throw new Error("tests import @microflow/db/testing.");
      `),
    ).toEqual([]);
  });
});

describe("@microflow/db exports", () => {
  test("every entry is named: no catch-all that would serve any file under src", () => {
    expect(Object.keys(exported).sort()).toEqual([".", "./flow-invitation", "./schema/*", "./testing"]);
  });

  test("every entry serves a file that exists", () => {
    for (const { default: target } of Object.values(exported)) {
      if (target.includes("*")) continue;
      expect(existsSync(`${PACKAGE_ROOT}${target}`), target).toBe(true);
    }
    expect(served("./schema/flow")).toBe("./src/schema/flow.ts");
    expect(served("./migrate")).toBeUndefined();
    expect(served("./index.test")).toBeUndefined();
  });

  test("every subpath the repo imports is one the package serves", () => {
    const unserved: string[] = [];
    for (const path of sources()) {
      for (const subpath of dbSubpathImports(readFileSync(`${REPO_ROOT}${path}`, "utf8"))) {
        const target = served(subpath);
        if (!target || !existsSync(`${PACKAGE_ROOT}${target}`)) {
          unserved.push(`${path} imports @microflow/db/${subpath.slice(2)}`);
        }
      }
    }
    expect(unserved).toEqual([]);
  });

  test("only test files import the test database", () => {
    const offenders: string[] = [];
    for (const path of sources()) {
      if (isTestFile(path)) continue;
      const source = readFileSync(`${REPO_ROOT}${path}`, "utf8");
      const fromOutside = dbSubpathImports(source).includes("./testing");
      // Inside the package it is a relative import.
      const fromInside =
        path.startsWith("packages/db/") && /(?:\bfrom|\bimport)\s*\(?\s*["']\.\.?\/(?:.*\/)?testing["']/.test(source);
      if (fromOutside || fromInside) offenders.push(path);
    }
    // `@microflow/db/testing` boots an in-process Postgres and binds it as the
    // process's database. In production code that would replace the real one.
    expect(offenders).toEqual([]);
  });
});
