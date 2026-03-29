import { env } from "@microflow/env/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const db = drizzle(env.DATABASE_URL);

await migrate(db, { migrationsFolder: import.meta.dir + "/migrations" });

console.log("Migrations complete");
process.exit(0);
