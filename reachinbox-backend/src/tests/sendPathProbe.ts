/**
 * End-to-end send-path probe.
 *
 * Creates a real schedule through the service layer, waits for the worker to
 * claim and attempt delivery, then reports the resulting DB and queue state.
 * Run against the docker-compose stack.
 */
import { db } from "../db/client.js";
import {
  users,
  senders,
  schedules,
  recipients,
  deliveryAttempts,
  outboxEvents,
} from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";

const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? 20000);

async function main() {
  const stamp = Date.now();

  const [user] = await db
    .insert(users)
    .values({
      providerSubject: `probe-${stamp}`,
      email: `probe-${stamp}@example.com`,
      name: "Send Path Probe",
    })
    .returning();

  const ownerId = user!.id;

  const { createSchedule } = await import("../services/scheduler.js");

  const created = await createSchedule({
    ownerId,
    subject: "Send path probe",
    body: "<p>probe body</p>",
    recipients: ["recipient-one@example.com", "recipient-two@example.com"],
    startAt: new Date(Date.now() + 1500),
    delayMs: 0,
    hourlyLimit: 5,
    idempotencyKey: `probe-${stamp}`,
    correlationId: "probe",
  });

  console.log("schedule:", created.id, "replayed:", created.replayed);

  await new Promise((r) => setTimeout(r, WAIT_MS));

  const rows = await db.query.recipients.findMany({
    where: eq(recipients.scheduleId, created.id),
    orderBy: (r, { asc }) => [asc(r.sequenceNo)],
  });

  console.log("\n--- recipients ---");
  for (const r of rows) {
    console.log(
      `  ${r.normalizedEmail}  status=${r.status}  claimedBy=${r.claimedBy ?? "-"}`,
    );
  }

  const attempts = await db.query.deliveryAttempts.findMany({
    where: inArray(
      deliveryAttempts.recipientId,
      rows.map((r) => r.id),
    ),
  });

  console.log("\n--- delivery attempts ---");
  for (const a of attempts) {
    console.log(
      `  attempt=${a.attempt} providerId=${a.providerId ?? "-"} failureCode=${a.failureCode ?? "-"}`,
    );
  }

  const events = await db.query.outboxEvents.findMany({
    where: inArray(
      outboxEvents.aggregateId,
      rows.map((r) => r.id),
    ),
  });

  console.log("\n--- outbox events ---");
  for (const e of events) {
    console.log(`  ${e.type} status=${e.status} attempts=${e.attempts} err=${e.lastError ?? "-"}`);
  }

  const claimWorked = rows.some((r) => r.claimedBy !== null);
  console.log(`\nCLAIM PATH: ${claimWorked ? "EXERCISED" : "NOT EXERCISED"}`);

  // Cleanup
  await db.delete(deliveryAttempts).where(
    inArray(
      deliveryAttempts.recipientId,
      rows.map((r) => r.id),
    ),
  );
  await db.delete(outboxEvents).where(
    inArray(
      outboxEvents.aggregateId,
      rows.map((r) => r.id),
    ),
  );
  await db.delete(recipients).where(eq(recipients.scheduleId, created.id));
  await db.delete(schedules).where(eq(schedules.id, created.id));
  await db.delete(senders).where(eq(senders.ownerId, ownerId));
  await db.delete(users).where(eq(users.id, ownerId));

  const { pool } = await import("../db/client.js");
  await pool.end();
  process.exit(0);
}

main().catch(async (error) => {
  console.error("PROBE FAILED:", error);
  const { pool } = await import("../db/client.js");
  await pool.end().catch(() => {});
  process.exit(1);
});
