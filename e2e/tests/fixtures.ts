import { test as base, expect, type Page } from "@playwright/test";
import { readSeed, type SeedResult } from "../global-setup.js";
import type { Redis } from "ioredis";

export const API_URL = process.env.E2E_API_URL ?? "http://localhost:3000";
export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3001";

export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

let seed: SeedResult | null = null;
let db: Db | null = null;

export function getSeed(): SeedResult {
  if (!seed) seed = readSeed();
  return seed;
}

export async function getDb(): Promise<Db> {
  if (db) return db;

  const { default: pg } = await import("pg");
  const s = getSeed();
  const client = new pg.Client({ connectionString: s.databaseUrl });
  await client.connect();

  db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount,
      };
    },
    async end() {
      await client.end();
    },
  };

  return db;
}

let redis: Redis | null = null;

async function getRedis(): Promise<Redis> {
  if (redis) return redis;
  const { Redis } = await import("ioredis");
  redis = new Redis(process.env.REDIS_URL ?? "redis://:reachinbox@localhost:6379/0");
  return redis;
}

/**
 * Clear a sender's rate-limit state.
 *
 * The hourly window is keyed per sender and shared across every test in a run,
 * so a test that asserts on capacity must start from a known-empty window or it
 * measures whatever earlier tests consumed.
 */
export async function resetSenderRateWindow(
  senderId: string,
): Promise<void> {
  const client = await getRedis();
  const pattern = `rate_limit:${senderId}:*`;
  const keys = await client.keys(pattern);
  if (keys.length > 0) await client.del(...keys);
}

/** Install a valid session cookie, as the real OAuth callback would. */
export async function authenticate(page: Page): Promise<SeedResult> {
  const s = getSeed();
  const domain = new URL(WEB_URL).hostname;

  await page.context().addCookies([
    {
      name: "session",
      value: s.token,
      domain,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);

  return s;
}

export const test = base.extend<{ seed: SeedResult; db: Db }>({
  seed: async ({}, use: (value: SeedResult) => Promise<void>) => {
    await use(getSeed());
  },

  db: async ({}, use: (value: Db) => Promise<void>) => {
    await use(await getDb());
  },
});

export { expect };

/* ------------------------------------------------------------------ */
/* Polling helpers                                                     */
/* ------------------------------------------------------------------ */

/** Wait until a condition holds, polling the database. */
export async function waitForDb(
  db: Db,
  check: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 750;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for: ${opts.label ?? "condition"}`,
  );
}

/** Count delivery attempts for a schedule; the duplicate-send canary. */
export async function attemptCount(
  db: Db,
  scheduleId: string,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from delivery_attempts da
       join recipients r on r.id = da.recipient_id
      where r.schedule_id = $1`,
    [scheduleId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function recipientStatuses(
  db: Db,
  scheduleId: string,
): Promise<{ status: string; email: string }[]> {
  const { rows } = await db.query<{ status: string; email: string }>(
    `select status, normalized_email as email from recipients
      where schedule_id = $1 order by sequence_no asc`,
    [scheduleId],
  );
  return rows;
}

export async function latestScheduleId(
  db: Db,
  ownerId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select id from schedules where owner_id = $1 order by created_at desc limit 1`,
    [ownerId],
  );
  return rows[0]?.id ?? null;
}
