/**
 * Distributed-system invariant test (SRS section 22).
 *
 * Verifies, against the real Redis + PostgreSQL + BullMQ stack:
 *  1. No worker bypasses hourly capacity (BE-RATE-002/003)
 *  2. Work is rescheduled, never dropped, when a window is full (BE-RATE-004)
 *  3. A terminal recipient is never sent again (BE-CONC-005)
 *  4. Exactly one attempt exists per recipient (BE-CONC-002)
 *  5. Sender minimum delay holds across instances (BE-RATE-001)
 *
 * Requires workers running with SMTP_TRANSPORT=stub and WORKER_CONCURRENCY>1.
 */
import { db, pool } from "../db/client.js";
import {
  users,
  senders,
  schedules,
  recipients,
  deliveryAttempts,
} from "../db/schema.js";
import { eq, inArray, asc } from "drizzle-orm";
import { emailQueue } from "../queue/connection.js";
import {
  releaseHourlyCapacity,
  currentWindowStart,
} from "../services/rateLimiter.js";

const RECIPIENTS = Number(process.env.INV_RECIPIENTS ?? 40);
const HOURLY_LIMIT = Number(process.env.INV_HOURLY_LIMIT ?? 10);
const MIN_DELAY_MS = Number(process.env.INV_MIN_DELAY_MS ?? 1000);
const SETTLE_MS = Number(process.env.INV_SETTLE_MS ?? 20000);

function pass(label: string, ok: boolean, detail = "") {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  const stamp = Date.now();
  console.log(`\n=== Invariant test: ${RECIPIENTS} recipients, limit ${HOURLY_LIMIT}, delay ${MIN_DELAY_MS}ms ===\n`);

  const [user] = await db
    .insert(users)
    .values({
      providerSubject: `inv-${stamp}`,
      email: `inv-${stamp}@example.com`,
      name: "Invariant Test",
    })
    .returning();
  const ownerId = user!.id;

  const [sender] = await db
    .insert(senders)
    .values({ ownerId, email: `sender-${stamp}@example.com`, transportRef: "stub" })
    .returning();
  const senderId = sender!.id;

  const [schedule] = await db
    .insert(schedules)
    .values({
      ownerId,
      subject: "Invariant run",
      body: "<p>x</p>",
      startAt: new Date(),
      // The worker enforces `schedule.delayMs`, so the minimum-delay
      // assertion is only meaningful when the schedule actually configures one.
      delayMs: MIN_DELAY_MS,
      hourlyLimit: HOURLY_LIMIT,
      idempotencyKey: `inv-${stamp}`,
      status: "queued",
    })
    .returning();
  const scheduleId = schedule!.id;

  const recipientRows = await db
    .insert(recipients)
    .values(
      Array.from({ length: RECIPIENTS }, (_, i) => ({
        scheduleId,
        normalizedEmail: `inv-${i}@example.com`,
        sequenceNo: i + 1,
        scheduledAt: new Date(),
        status: "queued" as const,
      })),
    )
    .returning({ id: recipients.id, sequenceNo: recipients.sequenceNo });

  // Clear any capacity left in this window from earlier runs.
  for (let i = 0; i < HOURLY_LIMIT + 5; i++) {
    await releaseHourlyCapacity(senderId, new Date(currentWindowStart(Date.now())));
  }

  // Publish one job per recipient with the same id scheme the app uses.
  for (const r of recipientRows) {
    await emailQueue.add(
      "send-email",
      { recipientId: r.id, scheduleId, senderId, attempt: 1 },
      { jobId: `recipient-${r.id}-1`, delay: 0, removeOnComplete: 100 },
    );
  }

  console.log(`published ${recipientRows.length} jobs; settling ${SETTLE_MS}ms...\n`);
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  const finalRows = await db.query.recipients.findMany({
    where: eq(recipients.scheduleId, scheduleId),
    orderBy: (r, { asc }) => [asc(r.sequenceNo)],
  });

  const ids = finalRows.map((r) => r.id);
  const attempts = await db.query.deliveryAttempts.findMany({
    where: inArray(deliveryAttempts.recipientId, ids),
    orderBy: [asc(deliveryAttempts.createdAt)],
  });

  const sent = finalRows.filter((r) => r.status === "sent");
  const deferred = finalRows.filter((r) => r.status === "queued");
  const failed = finalRows.filter((r) => r.status === "failed");
  const sending = finalRows.filter((r) => r.status === "sending");

  // 1 + 2: hourly capacity respected, remainder deferred not dropped.
  const capOk = pass(
    "sends never exceed the hourly limit",
    sent.length <= HOURLY_LIMIT,
    `sent=${sent.length} limit=${HOURLY_LIMIT}`,
  );
  const noDrop = pass(
    "no recipient dropped (every row accounted for)",
    sent.length + deferred.length + failed.length + sending.length === RECIPIENTS,
    `sent=${sent.length} queued=${deferred.length} failed=${failed.length} sending=${sending.length}`,
  );
  const resched = pass(
    "excess work deferred to a later window",
    deferred.length > 0 && deferred.every((r) => r.scheduledAt.getTime() > Date.now()),
    `queued=${deferred.length}`,
  );

  // 4: exactly one attempt per recipient -> no duplicate sends.
  const perRecipient = new Map<string, number>();
  for (const a of attempts) {
    perRecipient.set(a.recipientId, (perRecipient.get(a.recipientId) ?? 0) + 1);
  }
  const dupes = [...perRecipient.values()].filter((n) => n > 1);
  const noDupes = pass(
    "no recipient has more than one delivery attempt",
    dupes.length === 0,
    `attempts=${attempts.length} duplicated=${dupes.length}`,
  );

  // 3: terminal recipients are not re-offered work.
  const terminalWithJob = await Promise.all(
    sent.slice(0, 10).map(async (r) => {
      const job = await emailQueue.getJob(`recipient-${r.id}-1`);
      return job && (await job.getState()) !== "completed" ? r.id : null;
    }),
  );
  const noResend = pass(
    "terminal recipients are not re-sent",
    terminalWithJob.every((j) => j === null),
  );

  // 5: minimum delay between consecutive sends.
  const accepted = attempts
    .filter((a) => a.providerId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let minGapMs = Number.POSITIVE_INFINITY;
  for (let i = 1; i < accepted.length; i++) {
    const gap = accepted[i]!.createdAt.getTime() - accepted[i - 1]!.createdAt.getTime();
    if (gap < minGapMs) minGapMs = gap;
  }
  const delayOk =
    accepted.length < 2 || minGapMs >= MIN_DELAY_MS - 250; // allow clock jitter
  pass(
    "minimum inter-send delay holds",
    delayOk,
    `accepted=${accepted.length} required=${MIN_DELAY_MS}ms minGap=${Number.isFinite(minGapMs) ? minGapMs : "n/a"}ms`,
  );

  const all = capOk && noDrop && resched && noDupes && noResend && delayOk;
  console.log(`\nRESULT: ${all ? "PASS" : "FAIL"}`);

  await db.delete(deliveryAttempts).where(inArray(deliveryAttempts.recipientId, ids));
  await db.delete(recipients).where(eq(recipients.scheduleId, scheduleId));
  await db.delete(schedules).where(eq(schedules.id, scheduleId));
  await db.delete(senders).where(eq(senders.id, senderId));
  await db.delete(users).where(eq(users.id, ownerId));

  await pool.end();
  process.exit(all ? 0 : 1);
}

main().catch(async (error) => {
  console.error("INVARIANT TEST ERROR:", error);
  await pool.end().catch(() => {});
  process.exit(1);
});
