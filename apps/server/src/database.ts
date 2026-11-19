import { bindDb, createDb } from "@microflow/db";
import { env } from "@microflow/env/server";

/**
 * The server is the composition root for the database: it builds the
 * production adapter from `DATABASE_URL` and binds it as the process's handle.
 * `index.ts` imports this module first, so the binding precedes every module
 * that queries (`@microflow/auth`, the tRPC routers, the room store).
 */
bindDb(createDb(env.DATABASE_URL));
