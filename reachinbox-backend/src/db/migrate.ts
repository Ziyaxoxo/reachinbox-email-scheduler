import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";
import { logger } from "../observability/logger.js";
import path from "path";
import fs from "fs";

/**
 * Arbitrary but fixed key for the advisory lock that serialises migrations.
 *
 * Every replica runs this at boot, and Postgres gives us a lock that is
 * cluster-wide and automatically released if a holder dies, which is exactly
 * the primitive needed to make "migrate on startup" safe with more than one
 * container. The value only has to be agreed on by this codebase, not to be
 * unguessable.
 */
const MIGRATION_LOCK_KEY = 8_240_711_003;

/**
 * Applied at boot rather than by a separate deploy step.
 *
 * The service and its schema are versioned in the same repository and deployed
 * from the same image, so running the code against an older schema is a real
 * and easily-missed failure: a query selecting a column the database does not
 * have throws at runtime, not at startup. Applying the migration as part of
 * startup removes the window where that can happen, and removes a manual step
 * that needs production credentials.
 *
 * Migrations live outside dist/ because drizzle reads the .sql files from disk;
 * the Dockerfile copies them alongside the compiled output.
 */
/**
 * Locate the migration folder.
 *
 * The compiled container has them copied to ./migrations, but running from
 * source (dev server, tests) they only exist under src/db/migrations. Probing
 * both keeps one code path for every environment instead of making local
 * development depend on a build step that only the image performs.
 *
 * A missing folder is a hard error rather than a silent no-op: quietly
 * applying nothing is how a deploy ends up serving code against a schema that
 * is a version behind.
 */
function resolveMigrationsFolder(): string {
  const candidates = [
    path.join(process.cwd(), "migrations"),
    path.join(process.cwd(), "src", "db", "migrations"),
  ];

  for (const candidate of candidates) {
    // Drizzle keeps the journal in a meta/ subfolder, not beside the .sql
    // files, so that is what identifies a real migrations folder.
    if (fs.existsSync(path.join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }

  throw new Error(
    `No migration folder found. Looked in: ${candidates.join(", ")}`,
  );
}

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // Serialise across replicas. Two containers starting at once would
    // otherwise both see the same unapplied migration and race to apply it.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });

    logger.info("Database migrations applied");
  } finally {
    // Released in all cases, including a failed migration, so one broken
    // migration cannot wedge the other replicas on boot.
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => {});
    client.release();
  }
}
