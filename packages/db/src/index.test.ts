import { describe, expect, test } from "bun:test";
import { PgDatabase } from "drizzle-orm/pg-core";

import { bindDb, db } from "./index";
import { user } from "./schema/auth";
import { useTestDb } from "./testing";

/**
 * The binding rule for the process's database handle: bound once, by the
 * composition root; unusable before that; a read-only view afterwards.
 *
 * This process was bound when `./testing` loaded, so the unbound case runs in
 * a process of its own.
 */

/** Run a snippet against `./index` in a fresh, unbound process. */
function inUnboundProcess(snippet: string): string {
  const { stdout, stderr } = Bun.spawnSync({
    cmd: [process.execPath, "-e", `import { bindDb, db } from "./index.ts";\n${snippet}`],
    cwd: import.meta.dir,
  });
  return `${stdout.toString()}${stderr.toString()}`.trim();
}

describe("before a database is bound", () => {
  test("importing and holding the handle is fine; using it says what is missing", () => {
    const output = inUnboundProcess(`
      const held = db;
      for (const use of [() => held.query, () => held.select(), () => "query" in held, () => Object.keys(held)]) {
        try { use(); console.log("no error"); } catch (error) { console.log(error.message); }
      }
    `);

    const lines = output.split("\n");
    expect(lines.length).toBe(4);
    for (const line of lines) expect(line).toStartWith("No database is bound.");
  });

  test("a handle held from before the bind works after it", () => {
    const output = inUnboundProcess(`
      const held = db;
      const handle = { query: { marker: "bound" } };
      bindDb(handle);
      console.log(held.query.marker);
    `);

    expect(output).toBe("bound");
  });
});

describe("once a database is bound", () => {
  test("a second bind is refused, and the first binding stays", async () => {
    const engine = await useTestDb();

    expect(() => bindDb(engine)).toThrow("A database is already bound.");
    expect(() => bindDb({} as never)).toThrow("A database is already bound.");

    await db.insert(user).values({ id: "u1", name: "U", email: "u@example.com" });
    expect((await engine.select().from(user)).map((row) => row.id)).toEqual(["u1"]);
  });

  test("the handle answers as the bound database does", async () => {
    const engine = await useTestDb();

    expect(db instanceof PgDatabase).toBe(true);
    expect("query" in db).toBe(true);
    expect("no-such-property" in db).toBe(false);
    expect(Object.keys(db)).toEqual(Object.keys(engine));
    expect(Object.getOwnPropertyDescriptor(db, "query")?.value).toBe(engine.query);
    expect(Object.getOwnPropertyDescriptor(db, "no-such-property")).toBeUndefined();
    expect(db.query).toBe(engine.query);
  });

  test("a method taken off the handle still runs against the bound database", async () => {
    await useTestDb();
    const { insert, select } = db;

    await insert(user).values({ id: "u1", name: "U", email: "u@example.com" });

    expect((await select().from(user)).length).toBe(1);
  });

  test("the handle cannot be written through", async () => {
    const engine = await useTestDb();
    const writable = db as unknown as Record<string, unknown>;

    expect(() => {
      writable.query = {};
    }).toThrow(TypeError);
    expect(() => {
      delete writable.query;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(db, "extra", { value: 1 })).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(db, null)).toThrow(TypeError);

    expect(db.query).toBe(engine.query);
    expect("extra" in db).toBe(false);
  });
});
