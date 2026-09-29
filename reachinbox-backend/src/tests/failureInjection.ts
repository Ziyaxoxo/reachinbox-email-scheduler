/**
 * Failure injection: crash boundaries and dependency outages.
 *
 * Two things are hard to get right in a distributed mail system and are easy to
 * get wrong, so both are exercised here against the real stack:
 *
 *  1. Crash after the provider accepted a message but before the worker
 *     recorded it. The recipient must be recovered to `sent` from the durable
 *     attempt, and crucially the transport must NOT be called a second time.
 *     (BE-CONC-004, BE-SMTP-005)
 *
 *  2. Crash after claiming but before any SMTP contact. The expired lease must
 *     be reclaimable and the message delivered exactly once.
 *     (BE-PERSIST-002, BE-CONC-003)
 *
 * Transport-level call counts are read from the stub's Redis send log, because a
 * duplicate send that happened to succeed would still leave plausible-looking
 * database rows.
 *
 * Requires workers on SMTP_TRANSPORT=stub.
 */
import { db, pool } from "../db/client.js";
import {
  users,
  senders,
  schedules,
  recipients,
  deliveryAttempts,
  outboxEvents,
  slackConnections,
} from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createCipheriv, scryptSync } from "crypto";
import { emailQueue } from "../queue/connection.js";
import { redis } from "../services/rateLimiter.js";
import { env } from "../config/env.js";
import {
  STUB_SEND_LOG,
  STUB_CONFIG_KEY,
  STUB_COUNT_PREFIX,
} from "../services/smtp/stubTransport.js";

const SETTLE_MS = Number(process.env.FI_SETTLE_MS ?? 12_000);

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Count SMTP calls the transport actually made, per recipient address. */
async function transportCalls(to: string): Promise<number> {
  const raw = await redis.lrange(STUB_SEND_LOG, 0, -1);
  return raw
    .map((line) => {
      try {
        return JSON.parse(line) as { to: string; outcome: string };
      } catch {
        return null;
      }
    })
    .filter((r): r is { to: string; outcome: string } => r?.to === to).length;
}

async function clearTransportLog() {
  await redis.del(STUB_SEND_LOG);
  await redis.del(STUB_CONFIG_KEY);
  const counters = await redis.keys(`${STUB_COUNT_PREFIX}*`);
  if (counters.length > 0) await redis.del(...counters);
}

async function setStubConfig(config: Record<string, unknown>) {
  await redis.set(STUB_CONFIG_KEY, JSON.stringify(config));
}

interface Ctx {
  ownerId: string;
  senderId: string;
  scheduleId: string;
  recipientId: string;
  email: string;
  jobId: string;
}

async function makeRecipient(
  label: string,
  status: "queued" | "sending",
  claim: { expired: boolean } | null,
  attempt?: { providerId: string | null; failureCode: string | null },
): Promise<Ctx> {
  const stamp = Date.now();

  const [user] = await db
    .insert(users)
    .values({
      providerSubject: `fi-${label}-${stamp}`,
      email: `fi-${label}-${stamp}@example.com`,
      name: "Failure Injection",
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
      subject: `FI ${label}`,
      body: "<p>x</p>",
      startAt: new Date(Date.now() - 1_000),
      delayMs: 0,
      hourlyLimit: 100,
      idempotencyKey: `fi-${label}-${stamp}`,
      status: "queued",
    })
    .returning();

  const email = `fi-${label}-${stamp}@example.com`;

  const [recipient] = await db
    .insert(recipients)
    .values({
      scheduleId: schedule!.id,
      normalizedEmail: email,
      sequenceNo: 1,
      scheduledAt: new Date(Date.now() - 1_000),
      status,
      claimedBy: status === "sending" ? "crashed-worker" : null,
      claimExpiresAt:
        status === "sending"
          ? new Date(Date.now() + (claim?.expired ? -60_000 : 60_000))
          : null,
    })
    .returning();

  if (attempt) {
    await db.insert(deliveryAttempts).values({
      recipientId: recipient!.id,
      attempt: 1,
      providerId: attempt.providerId,
      failureCode: attempt.failureCode,
      sentAt: attempt.providerId ? new Date() : null,
    });
  }

  const jobId = `recipient-${recipient!.id}-1`;
  await emailQueue.add(
    "send-email",
    { recipientId: recipient!.id, scheduleId: schedule!.id, senderId: sender!.id, attempt: 1 },
    { jobId, delay: 0, removeOnComplete: 100 },
  );

  return {
    ownerId: user!.id,
    senderId: sender!.id,
    scheduleId: schedule!.id,
    recipientId: recipient!.id,
    email,
    jobId,
  };
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

/**
 * Encrypt with the same scheme `services/slack/oauth.ts` uses, so the seeded row
 * is indistinguishable from a real connection.
 */
function encryptSecret(plaintext: string): string {
  const key = scryptSync(env.ENCRYPTION_KEY, "reachinbox-salt", 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

/**
 * Seed an owner whose Slack connection is `connected` but whose token Slack
 * will reject.
 *
 * This is the case the SRS cares about: the side effect fails while the primary
 * effect succeeds. An unconnected workspace would prove less, because the
 * notifier short-circuits before attempting delivery.
 */
async function seedWithSlack(
  label: string,
  token = "xoxb-not-a-real-token-000000000000",
): Promise<{ ownerId: string; senderId: string }> {
  const stamp = Date.now();

  const [user] = await db
    .insert(users)
    .values({
      providerSubject: `fi-${label}-${stamp}`,
      email: `fi-${label}-${stamp}@example.com`,
      name: "Slack Failure Test",
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

  await db.insert(slackConnections).values({
    ownerId: user!.id,
    workspaceId: "T_FAKE_WORKSPACE",
    destinationRef: "C_FAKE_CHANNEL",
    encryptedSecretRef: encryptSecret(token),
    status: "connected",
  });

  return { ownerId: user!.id, senderId: sender!.id };
}

async function recipientStatus(id: string) {
  const rows = await db.query.recipients.findMany({
    where: eq(recipients.id, id),
    limit: 1,
  });
  return rows[0]?.status;
}

async function attemptRows(id: string) {
  return db.query.deliveryAttempts.findMany({
    where: eq(deliveryAttempts.recipientId, id),
  });
}

async function main() {
  console.log(`\n=== Failure injection: crash boundaries ===\n`);

  // Every scenario here drives the stub transport: it injects specific provider
  // failure modes and records one entry per call in `test:stub:sendlog`. On any
  // other transport those counters stay at zero and the suite reports a wall of
  // misleading "transportCalls=0" failures that look like product regressions.
  // Fail loudly instead.
  if (env.SMTP_TRANSPORT !== "stub") {
    console.error(
      `SMTP_TRANSPORT is "${env.SMTP_TRANSPORT}", expected "stub".\n` +
        `This suite must run against the stub transport:\n` +
        `  cd reachinbox-backend; $env:SMTP_TRANSPORT="stub"; docker-compose up -d --build\n` +
        `Do not interpret failures from a misconfigured run as product defects.`,
    );
    process.exit(1);
  }

  /* ---------------------------------------------------------------- */
  /* 1. Crash AFTER provider acceptance, BEFORE the status update.    */
  /*    The attempt row exists with a provider id; the recipient is    */
  /*    still 'sending'. Recovery must NOT call SMTP again.            */
  /* ---------------------------------------------------------------- */
  console.log("scenario: crash after provider acceptance");
  await clearTransportLog();

  const afterAccept = await makeRecipient(
    "afteraccept",
    "sending",
    { expired: true },
    { providerId: "provider-accepted-then-crashed", failureCode: null },
  );

  await sleep(SETTLE_MS);

  const afterAcceptStatus = await recipientStatus(afterAccept.recipientId);
  const afterAcceptAttempts = await attemptRows(afterAccept.recipientId);
  const afterAcceptCalls = await transportCalls(afterAccept.email);

  check(
    "recovered to sent from the durable attempt",
    afterAcceptStatus === "sent",
    `status=${afterAcceptStatus}`,
  );
  check(
    "no second SMTP call was made",
    afterAcceptCalls === 0,
    `transportCalls=${afterAcceptCalls}`,
  );
  check(
    "no duplicate attempt row was written",
    afterAcceptAttempts.length === 1,
    `attempts=${afterAcceptAttempts.length}`,
  );

  await cleanup(afterAccept);

  /* ---------------------------------------------------------------- */
  /* 2. Crash AFTER claim, BEFORE any SMTP contact.                   */
  /*    Recipient is 'sending' with an expired lease and no attempt.   */
  /*    The lease must be reclaimable and the message delivered once.  */
  /* ---------------------------------------------------------------- */
  console.log("\nscenario: crash after claim, before SMTP");
  await clearTransportLog();

  const beforeSend = await makeRecipient("beforeSend", "sending", { expired: true });

  await sleep(SETTLE_MS);

  const beforeSendStatus = await recipientStatus(beforeSend.recipientId);
  const beforeSendAttempts = await attemptRows(beforeSend.recipientId);
  const beforeSendCalls = await transportCalls(beforeSend.email);

  check(
    "expired lease was reclaimed and the message delivered",
    beforeSendStatus === "sent",
    `status=${beforeSendStatus}`,
  );
  check(
    "delivered exactly once",
    beforeSendCalls === 1,
    `transportCalls=${beforeSendCalls}`,
  );
  check(
    "exactly one attempt recorded",
    beforeSendAttempts.length === 1,
    `attempts=${beforeSendAttempts.length}`,
  );
  check(
    "provider id was recorded",
    Boolean(beforeSendAttempts[0]?.providerId),
  );

  await cleanup(beforeSend);

  /* ---------------------------------------------------------------- */
  /* 3. A live lease is NOT stealable.                                */
  /*    Two workers must not both send: the second must lose the claim.*/
  /* ---------------------------------------------------------------- */
  console.log("\nscenario: a live lease is respected");

  const before = await transportCalls("nobody@example.com");
  const live = await makeRecipient("liveLease", "sending", { expired: false });
  await sleep(SETTLE_MS);

  const liveStatus = await recipientStatus(live.recipientId);
  const liveCalls = await transportCalls(live.email);

  check(
    "recipient with a live lease is not sent by another worker",
    liveCalls === 0 && liveStatus === "sending",
    `status=${liveStatus} transportCalls=${liveCalls}`,
  );
  void before;

  await cleanup(live);

  /* ---------------------------------------------------------------- */
  /* 4. Transient provider failure retries and eventually succeeds.  */
  /* ---------------------------------------------------------------- */
  console.log("\nscenario: transient provider failure");

  await clearTransportLog();
  const transient = await makeRecipient("transient", "queued", null);
  // Scoped to this recipient: a process-wide trip count would already be
  // consumed by the earlier scenarios in this same run.
  await setStubConfig({
    failWith: "ECONNRESET",
    classification: "transient",
    failRecipient: transient.email,
    failFirstN: 1,
  });

  // Retry backoff is 5s * attempt, plus the delay limiter.
  await sleep(SETTLE_MS + 25_000);

  const transientStatus = await recipientStatus(transient.recipientId);
  const transientCalls = await transportCalls(transient.email);
  const transientAttempts = await attemptRows(transient.recipientId);

  check(
    "transient failure eventually delivers",
    transientStatus === "sent",
    `status=${transientStatus}`,
  );
  check(
    "the provider was retried after the transient error",
    transientCalls === 2,
    `transportCalls=${transientCalls}`,
  );
  check(
    "both attempts were audited",
    transientAttempts.length === 2,
    `attempts=${transientAttempts.length}`,
  );
  check(
    "the first attempt recorded the failure code",
    transientAttempts.some((a) => a.failureCode === "ECONNRESET"),
  );

  await clearTransportLog();
  await cleanup(transient);

  /* ---------------------------------------------------------------- */
  /* 5. A permanent failure is terminal and is not retried forever.  */
  /* ---------------------------------------------------------------- */
  console.log("\nscenario: permanent provider failure");

  await clearTransportLog();
  const permanent = await makeRecipient("permanent", "queued", null);
  await setStubConfig({
    failWith: "E550",
    classification: "permanent",
    failRecipient: permanent.email,
  });

  await sleep(SETTLE_MS);

  const permanentStatus = await recipientStatus(permanent.recipientId);
  const permanentCalls = await transportCalls(permanent.email);
  const permanentAttempts = await attemptRows(permanent.recipientId);

  check(
    "permanent failure is terminal",
    permanentStatus === "failed",
    `status=${permanentStatus}`,
  );
  check(
    "not retried after a permanent error",
    permanentCalls === 1,
    `transportCalls=${permanentCalls}`,
  );
  check(
    "the failure code was recorded",
    permanentAttempts[0]?.failureCode === "E550",
    `code=${permanentAttempts[0]?.failureCode}`,
  );

  await clearTransportLog();
  await cleanup(permanent);

  /* ---------------------------------------------------------------- */
  /* 6. An ambiguous outcome is bounded, not blindly retried.        */
  /* ---------------------------------------------------------------- */
  console.log("\nscenario: ambiguous provider outcome");

  await clearTransportLog();
  const ambiguous = await makeRecipient("ambiguous", "queued", null);
  await setStubConfig({
    failWith: "ECONNRESET",
    classification: "ambiguous",
    failRecipient: ambiguous.email,
  });

  await sleep(SETTLE_MS);

  const ambiguousStatus = await recipientStatus(ambiguous.recipientId);
  const ambiguousCalls = await transportCalls(ambiguous.email);
  const ambiguousAttempts = await attemptRows(ambiguous.recipientId);

  check(
    "ambiguous outcome does not become a terminal retry loop",
    ambiguousCalls === 1,
    `transportCalls=${ambiguousCalls}`,
  );
  check(
    "ambiguous outcome is recorded as a failure, not a silent send",
    ambiguousStatus === "failed",
    `status=${ambiguousStatus}`,
  );
  check(
    "the ambiguous attempt is timestamped as a send-time event",
    ambiguousAttempts[0]?.sentAt !== null &&
      ambiguousAttempts[0]?.sentAt !== undefined,
    "sentAt is set so the window is auditable",
  );

  await clearTransportLog();
  await cleanup(ambiguous);

  /* ---------------------------------------------------------------- */
  /* 7. Slack notification failure must be independent of delivery.   */
  /*    A "connected" workspace whose token is rejected by Slack is    */
  /*    the interesting case: the side effect fails while the primary   */
  /*    effect succeeds, and the notification retries on its own.      */
  /* ---------------------------------------------------------------- */
  console.log("\nscenario: Slack notification failure with a connected workspace");

  await clearTransportLog();
  const slackCtx = await seedWithSlack("slackfail");

  // hourlyLimit 1 with 3 recipients guarantees a threshold event.
  const recipientsToSend = Array.from(
    { length: 3 },
    (_, i) => `slackfail-${i}@example.com`,
  );

  const [schedule] = await db
    .insert(schedules)
    .values({
      ownerId: slackCtx.ownerId,
      subject: "Slack failure",
      body: "<p>x</p>",
      startAt: new Date(Date.now() - 1_000),
      delayMs: 0,
      hourlyLimit: 1,
      idempotencyKey: `slackfail-${Date.now()}`,
      status: "queued",
    })
    .returning();

  const inserted = await db
    .insert(recipients)
    .values(
      recipientsToSend.map((email, i) => ({
        scheduleId: schedule!.id,
        normalizedEmail: email,
        sequenceNo: i + 1,
        scheduledAt: new Date(Date.now() - 1_000),
        status: "queued" as const,
      })),
    )
    .returning({ id: recipients.id });

  for (const r of inserted) {
    await emailQueue.add(
      "send-email",
      {
        recipientId: r.id,
        scheduleId: schedule!.id,
        senderId: slackCtx.senderId,
        attempt: 1,
      },
      { jobId: `recipient-${r.id}-1`, delay: 0, removeOnComplete: 100 },
    );
  }

  await sleep(SETTLE_MS + 15_000);

  const slackStatuses = await db.query.recipients.findMany({
    where: eq(recipients.scheduleId, schedule!.id),
  });

  check(
    "the email still delivered despite Slack being rejected",
    slackStatuses.some((r) => r.status === "sent"),
    `statuses=${slackStatuses.map((r) => r.status).join(",")}`,
  );
  check(
    "no recipient was failed because of a Slack error",
    slackStatuses.every((r) => r.status !== "failed"),
  );

  const slackEvents = await db.query.outboxEvents.findMany({
    where: eq(outboxEvents.type, "slack.rate_limit"),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 1,
  });

  const slackEvent = slackEvents[0];
  check(
    "a durable rate-limit notification event was written",
    Boolean(slackEvent),
  );

  if (slackEvent) {
    check(
      "the notification did not report success against a rejected token",
      slackEvent.status !== "completed",
      `status=${slackEvent.status}`,
    );
    check(
      "the notification is retried independently of the email",
      slackEvent.attempts > 0 || slackEvent.status === "processing",
      `attempts=${slackEvent.attempts} status=${slackEvent.status}`,
    );
    check(
      "the failure reason is retained for diagnosis",
      Boolean(slackEvent.lastError),
      `lastError=${slackEvent.lastError ?? "none"}`,
    );
  }

  // Cleanup: the threshold event is keyed by sender+window, so remove it too.
  await db
    .delete(outboxEvents)
    .where(inArray(outboxEvents.aggregateId, slackEvent ? [slackEvent.id] : []));

  await db
    .delete(deliveryAttempts)
    .where(
      inArray(
        deliveryAttempts.recipientId,
        inserted.map((r) => r.id),
      ),
    );
  await db
    .delete(recipients)
    .where(eq(recipients.scheduleId, schedule!.id));
  await db.delete(schedules).where(eq(schedules.id, schedule!.id));
  await db.delete(slackConnections).where(eq(slackConnections.ownerId, slackCtx.ownerId));
  await db.delete(senders).where(eq(senders.id, slackCtx.senderId));
  await db.delete(users).where(eq(users.id, slackCtx.ownerId));

  console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed)`);

  await redis.quit().catch(() => {});
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("FAILURE INJECTION ERROR:", error);
  await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
