/**
 * Seeds a test user and mints a real session token.
 *
 * Deliberately does NOT add a backdoor login endpoint. The token is signed with
 * the backend's own JWT_SECRET and the user row is inserted directly, so the
 * suite exercises the production auth middleware: cookie parsing, JWT
 * verification and the owner-scope database lookup.
 */
import { createHmac, randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

export interface SeededUser {
  userId: string;
  email: string;
  name: string;
  token: string;
  senderId: string;
  databaseUrl: string;
}

/** Minimal .env reader: avoids pulling dotenv into the harness. */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function signSessionToken(userId: string, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ sub: userId, iat: now, exp: now + 60 * 60 }),
  );
  const signature = b64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

export interface SeedResult {
  userId: string;
  email: string;
  name: string;
  token: string;
  senderId: string;
  databaseUrl: string;
}

export async function seedUser(label = "e2e"): Promise<SeedResult> {
  const backendRoot = join(here, "..", "..", "reachinbox-backend");
  const env = readEnvFile(join(backendRoot, ".env"));

  const databaseUrl =
    process.env.DATABASE_URL ??
    env.DATABASE_URL ??
    "postgresql://reachinbox:reachinbox@localhost:5432/reachinbox";
  const jwtSecret = process.env.JWT_SECRET ?? env.JWT_SECRET;

  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error(
      "JWT_SECRET not found. Copy reachinbox-backend/.env.example to .env first.",
    );
  }

  const stamp = Date.now();
  const email = `${label}-${stamp}@example.com`;
  const name = "E2E Operator";
  const userId = randomUUID();

  // Dynamic import keeps pg out of the module graph for non-DB helpers.
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(
      `insert into users (id, provider_subject, email, name, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())
       on conflict (provider_subject) do update set name = excluded.name`,
      [userId, `e2e-${label}-${stamp}`, email, name],
    );

    // Re-read in case the provider_subject already existed.
    const { rows } = await client.query<{ id: string }>(
      "select id from users where provider_subject = $1",
      [`e2e-${label}-${stamp}`],
    );
    const resolvedUserId = rows[0]?.id ?? userId;

    const senderRes = await client.query<{ id: string }>(
      `insert into senders (id, owner_id, email, transport_ref, status, created_at, updated_at)
       values ($1, $2, $3, 'ethereal', 'active', now(), now())
       on conflict do nothing
       returning id`,
      [randomUUID(), resolvedUserId, email],
    );

    let senderId = senderRes.rows[0]?.id;
    if (!senderId) {
      const existing = await client.query<{ id: string }>(
        "select id from senders where owner_id = $1 order by created_at asc limit 1",
        [resolvedUserId],
      );
      senderId = existing.rows[0]!.id;
    }

    return {
      userId: resolvedUserId,
      email,
      name,
      token: signSessionToken(resolvedUserId, jwtSecret),
      senderId: senderId!,
      databaseUrl,
    };
  } finally {
    await client.end();
  }
}

/** Remove every schedule/recipient/attempt belonging to a seeded owner. */
export async function cleanupOwner(userId: string, databaseUrl: string): Promise<void> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `delete from delivery_attempts where recipient_id in (
         select id from recipients where schedule_id in (
           select id from schedules where owner_id = $1))`,
      [userId],
    );
    await client.query(
      `delete from outbox_events where aggregate_id in (
         select id from recipients where schedule_id in (
           select id from schedules where owner_id = $1))
         or aggregate_id in (select id from schedules where owner_id = $1)`,
      [userId],
    );
    await client.query(
      `delete from recipients where schedule_id in (select id from schedules where owner_id = $1)`,
      [userId],
    );
    await client.query("delete from schedules where owner_id = $1", [userId]);
    await client.query("delete from rate_windows where sender_id in (select id from senders where owner_id = $1)", [userId]);
    await client.query("delete from senders where owner_id = $1", [userId]);
  } finally {
    await client.end();
  }
}
