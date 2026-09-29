import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Hosted Postgres (Neon, Supabase, ...) requires TLS, but node-postgres
  // ignores ?sslmode=require in the connection string. Enable TLS only when
  // the URL asks for it, so local Docker (plain TCP) is completely untouched.
  ...(env.DATABASE_URL.includes("sslmode=require")
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});

export const db = drizzle(pool, { schema });
export type Database = typeof db;
export { pool };
