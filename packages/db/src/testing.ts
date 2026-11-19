import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { bindDb, type Db } from "./index";
import * as schema from "./schema";

/**
 * The second adapter behind `Db`: Postgres itself, compiled to WebAssembly and
 * running inside the test process (PGlite), with the real migrations from
 * `./migrations` applied. Tests run the SQL production runs, against the
 * indexes and constraints production has. No Docker, network or environment.
 *
 * One difference from a pooled server: PGlite is a single connection, so a
 * query made on `db` from inside a `db.transaction()` callback waits for that
 * transaction forever. Inside a transaction, use the `tx` it hands you.
 */

// One engine per test process, booted and migrated while this module loads.
// That takes one to several seconds on a busy machine; doing it at import
// keeps it out of every test's and hook's timeout.
const client = new PGlite();
const engine = drizzle(client, { schema });
await migrate(engine, { migrationsFolder: `${import.meta.dir}/migrations` });
const tables = (
  await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  )
).rows.map((row) => row.tablename);

// This module is the test process's composition root for the database: it
// binds the engine once, here, as the server binds its pool once at start-up.
// Under `bun test` every test file shares the process, and so this binding.
bindDb(engine);

/**
 * Empty the in-process database and return it. It is already the process's
 * `db`: importing this module bound it.
 *
 * Call it before each test (or once per file when the tests do not collide).
 * Every call empties every table and drops the triggers a test added to make a
 * statement fail, so a test starts from the migrated schema and nothing else.
 */
export async function useTestDb(): Promise<Db> {
  const { rows: triggers } = await client.query<{ name: string; table: string }>(
    `SELECT t.tgname AS name, c.relname AS "table"
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal`,
  );
  for (const trigger of triggers) {
    await client.exec(`DROP TRIGGER "${trigger.name}" ON "${trigger.table}"`);
  }
  // DELETE, not TRUNCATE: a few milliseconds here against tens to hundreds.
  // Every foreign key cascades, so the order of the tables does not matter.
  await client.exec(tables.map((table) => `DELETE FROM "${table}";`).join("\n"));

  return engine;
}
