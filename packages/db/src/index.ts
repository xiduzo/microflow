import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "./schema";

/**
 * A drizzle handle over the Microflow schema, whichever Postgres is behind it.
 *
 * This type is the seam. Two adapters satisfy it: `createDb` (node-postgres,
 * production) and the in-process Postgres in `./testing` (PGlite, tests). Both
 * run the same SQL against the same migrations, so nothing above the handle
 * knows which one it holds.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The production adapter: a node-postgres pool on `connectionString`. */
export function createDb(connectionString: string): Db {
  return drizzle(connectionString, { schema });
}

let bound: Db | undefined;

/**
 * Give the process its database: once, before the first query. The server
 * binds `createDb(env.DATABASE_URL)` at start-up (`apps/server/src/database.ts`);
 * a test process is bound to the in-process Postgres when `./testing` loads.
 *
 * A second bind is a programming error and throws. Replacing the handle would
 * strand the first one's connection pool, and move modules that are mid-query
 * onto another database.
 */
export function bindDb(handle: Db): void {
  if (bound) {
    throw new Error(
      "A database is already bound. bindDb() is called once per process, by its composition root.",
    );
  }
  bound = handle;
}

function current(): Db {
  if (!bound) {
    throw new Error(
      "No database is bound. Call bindDb() first: apps/server does at start-up, tests import @microflow/db/testing.",
    );
  }
  return bound;
}

/**
 * The process's database handle: a read-only view of whatever `bindDb` bound.
 * A module may import it (and hold it) before the composition root runs; only
 * using it needs a bound database. Never constructed from the environment
 * here: an unbound process fails on its first query instead of reaching
 * whichever database `DATABASE_URL` happens to name.
 *
 * Everything that reads is forwarded to the bound handle, so the view answers
 * as the handle would: property reads (methods bound to the handle, which is
 * all drizzle's builders and better-auth's adapter use), `in`, `instanceof`
 * and key enumeration. Everything that writes is refused: an assignment
 * through the view would land nowhere a reader looks.
 */
export const db: Db = new Proxy({} as Db, {
  get(_view, property) {
    const handle = current();
    const value = Reflect.get(handle, property, handle);
    return typeof value === "function" ? value.bind(handle) : value;
  },
  has(_view, property) {
    return Reflect.has(current(), property);
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(current());
  },
  ownKeys() {
    return Reflect.ownKeys(current());
  },
  getOwnPropertyDescriptor(_view, property) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current(), property);
    // The view holds no properties of its own, so a proxy may only report one
    // as configurable.
    return descriptor && { ...descriptor, configurable: true };
  },
  set: () => false,
  defineProperty: () => false,
  deleteProperty: () => false,
  setPrototypeOf: () => false,
  preventExtensions: () => false,
});
