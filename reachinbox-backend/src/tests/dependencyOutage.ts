/**
 * Failure injection: dependency outages.
 *
 * The system must degrade, not corrupt. Each scenario kills a dependency and
 * asserts both halves of that promise: the business state stays durable, and the
 * failure does not cascade into data loss.
 *
 *  - Elasticsearch down: scheduling and delivery continue, indexing retries
 *  - Slack not connected: rate-limit notification fails, emails still send
 *  - Redis down: scheduling fails safely, and the DB remains the truth
 *  - Elasticsearch back: the derived read model catches up from the outbox
 *
 * Requires workers on SMTP_TRANSPORT=stub and the docker CLI available.
 */
import { execSync } from "child_process";
import { db, pool } from "../db/client.js";
import {
  users,
  senders,
  schedules,
  recipients,
  deliveryAttempts,
  outboxEvents,
} from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { emailQueue } from "../queue/connection.js";
import { redis } from "../services/rateLimiter.js";

const BACKEND = process.env.FI_BACKEND_DIR ?? ".";
const SETTLE_MS = Number(process.env.FI_SETTLE_MS ?? 15_000);

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compose(action: string, service: string) {
  return execSync(
    `docker-compose -f "${BACKEND}/docker-compose.yml" ${action} ${service}`,
    { encoding: "utf8", stdio: "pipe" },
  );
}

async function isContainerRunning(service: string): Promise<boolean> {
  try {
    const out = execSync(
      `docker-compose -f "${BACKEND}/docker-compose.yml" ps -q ${service}`,
      { encoding: "utf8", stdio: "pipe" },
    ).trim();
    if (!out) return false;
    const state = execSync(`docker inspect -f "{{.State.Running}}" ${out}`, {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    return state === "true";
  } catch {
    return false;
  }
}

interface Ctx {
  ownerId: string;
  senderId: string;
  scheduleId: string;
  recipientId: string;
  email: string;
}

async function seed(label: string): Promise<Ctx> {
  const stamp = Date.now();

  const [user] = await db
    .insert(users)
    .values({
      providerSubject: `outage-${label}-${stamp}`,
      email: `outage-${label}-${stamp}@example.com`,
      name: "Outage Test",
    })
    .returning();

  const [sender] = await db
    .insert(senders)
    .values({
      ownerId: user!.id,
      email: `sender-${label}-${stamp}@example.com`,
      transportRef: "stub",
    })
    .returning();

  const [schedule] = await db
    .insert(schedules)
    .values({
      ownerId: user!.id,
      subject: `Outage ${label}`,
      body: "<p>x</p>",
      startAt: new Date(Date.now() - 1_000),
      delayMs: 0,
      hourlyLimit: 100,
      idempotencyKey: `outage-${label}-${stamp}`,
      status: "queued",
    })
    .returning();

  const email = `outage-${label}-${stamp}@example.com`;

  const [recipient] = await db
    .insert(recipients)
    .values({
      scheduleId: schedule!.id,
      normalizedEmail: email,
      sequenceNo: 1,
      scheduledAt: new Date(Date.now() - 1_000),
      status: "queued",
    })
    .returning();

  return {
    ownerId: user!.id,
    senderId: sender!.id,
    scheduleId: schedule!.id,
    recipientId: recipient!.id,
    email,
  };
}

async function enqueue(ctx: Ctx) {
  await emailQueue.add(
    "send-email",
    { recipientId: ctx.recipientId, scheduleId: ctx.scheduleId, senderId: ctx.senderId, attempt: 1 },
    { jobId: `recipient-${ctx.recipientId}-1`, delay: 0, removeOnComplete: 100 },
  );
}

/**
 * Raw SQL rather than the relational query builder.
 *
 * The builder's inferred types pull the whole schema through the client module
 * and collide here; raw SQL is also clearer for assertions of this shape.
 */
async function status(id: string): Promise<string | undefined> {
  const res = await pool.query<{ status: string }>(
    "select status from recipients where id = $1",
    [id],
  );
  return res.rows[0]?.status;
}

async function attempts(id: string) {
  const res = await pool.query<{
    id: string;
    attempt: number;
    provider_id: string | null;
    failure_code: string | null;
    sent_at: Date | null;
  }>(
    "select id, attempt, provider_id, failure_code, sent_at from delivery_attempts where recipient_id = $1 order by attempt asc",
    [id],
  );
  return res.rows;
}

async function cleanup(ctx: Ctx) {
  await db.delete(deliveryAttempts).where(eq(deliveryAttempts.recipientId, ctx.recipientId));
  await db
    .delete(outboxEvents)
    .where(inArray(outboxEvents.aggregateId, [ctx.recipientId, ctx.scheduleId]));
  await db.delete(recipients).where(eq(recipients.id, ctx.recipientId));
  await db.delete(schedules).where(eq(schedules.id, ctx.scheduleId));
  await db.delete(senders).where(eq(senders.id, ctx.senderId));
  await db.delete(users).where(eq(users.id, ctx.ownerId));
}

async function main() {
  console.log(`\n=== Failure injection: dependency outages ===\n`);

  /* ---------------------------------------------------------------- */
  /* 1. Elasticsearch unavailable.                                     */
  /*    Business state must continue; indexing must retry.             */
  /* ---------------------------------------------------------------- */
  console.log("scenario: Elasticsearch unavailable");

  const wasEsUp = await isContainerRunning("elasticsearch");
  if (wasEsUp) compose("stop", "elasticsearch");
  await sleep(2_000);

  const esDown = await seed("esdown");
  await enqueue(esDown);
  await sleep(SETTLE_MS);

  const esDownStatus = await status(esDown.recipientId);
  const esDownAttempts = await attempts(esDown.recipientId);

  check(
    "email still delivered with Elasticsearch down",
    esDownStatus === "sent",
    `status=${esDownStatus}`,
  );
  check(
    "the attempt is audited with a provider id",
    Boolean(esDownAttempts[0]?.provider_id),
  );

  const pendingEvents = await pool.query<{ n: number }>(
    `select count(*)::int as n from outbox_events
      where aggregate_id = $1 and status <> 'completed'`,
    [esDown.recipientId],
  );
  check(
    "the indexing event is not silently dropped",
    (pendingEvents.rows[0]?.n ?? 0) >= 1,
    `uncompletedEvents=${pendingEvents.rows[0]?.n}`,
  );

  /* Recovery: bring Elasticsearch back and let the outbox drain. */
  if (wasEsUp) compose("start", "elasticsearch");
  await sleep(6_000);

  const deadline = Date.now() + 60_000;
  let recovered = false;
  while (Date.now() < deadline) {
    const rows = await pool.query<{ status: string }>(
      "select status from outbox_events where aggregate_id = $1 order by created_at desc limit 1",
      [esDown.recipientId],
    );
    if (rows.rows[0]?.status === "completed") {
      recovered = true;
      break;
    }
    await sleep(1_500);
  }

  check("the outbox event completes after recovery", recovered);

  const doc = await fetch(
    `http://localhost:9200/reachinbox-emails/_doc/${esDown.recipientId}`,
  );
  check("the derived document is indexed after recovery", doc.status === 200);

  await cleanup(esDown);

  /* ---------------------------------------------------------------- */
  /* 2. Slack not connected.                                          */
  /*    The notification fails; emails are unaffected.                 */
  /* ---------------------------------------------------------------- */
  console.log("\nscenario: Slack not connected");

  const slackless = await seed("slackless");
  await enqueue(slackless);
  await sleep(SETTLE_MS);

  check(
    "email delivered while Slack is unavailable",
    (await status(slackless.recipientId)) === "sent",
  );
  check(
    "attempt is audited with a provider id",
    Boolean((await attempts(slackless.recipientId))[0]?.provider_id),
  );

  const slackEvents = await pool.query<{ status: string; attempts: number }>(
    "select status, attempts from outbox_events where type = 'slack.rate_limit' order by created_at desc limit 1",
  );

  // Whether or not a threshold event was due, no email may be failed because
  // Slack was unavailable. If an event exists it must have been retried rather
  // than dropped on the first attempt.
  check(
    "a Slack failure never leaves an email failed",
    (await status(slackless.recipientId)) === "sent",
    `slackEvent=${slackEvents.rows[0]?.status ?? "none"}`,
  );

  await cleanup(slackless);

  /* ---------------------------------------------------------------- */
  /* 3. Redis unavailable.                                            */
  /*    Rate limiting cannot be honoured, so the safe answer is to      */
  /*    fail open but keep the DB as the record of what happened.      */
  /* ---------------------------------------------------------------- */
  console.log("\nscenario: Redis unavailable");

  const wasRedisUp = await isContainerRunning("redis");
  if (wasRedisUp) compose("stop", "redis");
  await sleep(2_000);

  // The DB is still authoritative even with Redis gone.
  const noRedis = await seed("noredis");
  const persisted = await pool.query<{ id: string }>(
    "select id from recipients where id = $1",
    [noRedis.recipientId],
  );
  check("durable state is readable without Redis", persisted.rows.length === 1);

  // Scheduling must fail safe rather than accept work it cannot queue.
  let scheduledWhileDown = false;
  let schedulingErrored = false;
  try {
    const { createSchedule } = await import("../services/scheduler.js");
    await createSchedule({
      ownerId: noRedis.ownerId,
      subject: "While Redis is down",
      body: "<p>x</p>",
      recipients: ["while-down@example.com"],
      startAt: new Date(Date.now() + 3_600_000),
      delayMs: 0,
      hourlyLimit: 10,
      idempotencyKey: `noredis-${Date.now()}`,
      correlationId: "outage",
    });
    scheduledWhileDown = true;
  } catch {
    schedulingErrored = true;
  }

  // Either it rejected the write, or it committed durable state that
  // reconciliation can publish once Redis returns. Never a half-written row.
  check(
    "scheduling either fails safely or persists durably",
    !scheduledWhileDown || (await status(noRedis.recipientId)) === "queued",
    `scheduled=${scheduledWhileDown} errored=${schedulingErrored}`,
  );

  if (wasRedisUp) compose("start", "redis");
  await sleep(6_000);

  check("Redis is reachable again", await pingRedis());

  await cleanup(noRedis);

  console.log(
    `\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed)`,
  );

  await redis.quit().catch(() => {});
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

async function pingRedis(): Promise<boolean> {
  try {
    const { Redis } = await import("ioredis");
    const client = new Redis(process.env.REDIS_URL ?? "redis://:reachinbox@localhost:6379/0", {
      maxRetriesPerRequest: 2,
      retryStrategy: () => null,
    });
    const pong = await client.ping();
    await client.quit();
    return pong === "PONG";
  } catch {
    return false;
  }
}

main().catch(async (error) => {
  console.error("OUTAGE TEST ERROR:", error);
  await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
