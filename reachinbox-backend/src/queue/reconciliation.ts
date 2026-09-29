import { db } from "../db/client.js";
import { recipients, schedules, outboxEvents } from "../db/schema.js";
import { and, eq, lte, inArray, lt, sql } from "drizzle-orm";
import { emailQueue } from "./connection.js";
import { enqueueOutboxEvent, republishEmailJob } from "./outboxPublisher.js";
import { refreshScheduleStatus } from "../db/repositories/scheduleRepo.js";
import { logger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";

const BATCH_SIZE = 1000;

/**
 * Rebuild queue state from the authoritative database.
 *
 * The DB is the source of truth. Anything still `pending`/`queued`/`sending`
 * with an expired lease is re-published idempotently; terminal history
 * (sent/failed/cancelled) is never requeued, so a restart cannot produce a
 * second send for a message that already went out.
 */
export async function reconcilePendingWork(): Promise<void> {
  const log = logger.child({ scan: "reconciliation" });

  try {
    const now = new Date();

    // 0. Repair parent statuses before anything else. A schedule whose
    //    recipients have all finished but whose own status is still
    //    non-terminal is a crash-window artefact: the recipient rows are the
    //    source of truth, so recompute rather than requeue. This is a read-only
    //    correction and must not depend on there being any queue work to do.
    await repairScheduleStatuses();

    // 1. Pending future + due work that has no live job.
    //    `sending` rows whose lease expired are included: the worker crashed
    //    mid-flight, so the work is safe to re-offer.
    const recoverable = await db
      .select({
        id: recipients.id,
        scheduleId: recipients.scheduleId,
        scheduledAt: recipients.scheduledAt,
        status: recipients.status,
        claimExpiresAt: recipients.claimExpiresAt,
      })
      .from(recipients)
      .where(
        and(
          inArray(recipients.status, ["scheduled", "queued"]),
          lte(recipients.scheduledAt, now),
        ),
      )
      .limit(BATCH_SIZE);

    const expiredLeases = await db
      .select({
        id: recipients.id,
        scheduleId: recipients.scheduleId,
        scheduledAt: recipients.scheduledAt,
      })
      .from(recipients)
      .where(
        and(
          eq(recipients.status, "sending"),
          lt(recipients.claimExpiresAt, now),
        ),
      )
      .limit(BATCH_SIZE);

    const candidates = [...recoverable, ...expiredLeases];
    if (candidates.length === 0) {
      await republishPendingOutbox();
      return;
    }

    log.info({ candidates: candidates.length }, "Reconciling recipient work");

    // 2. Drop claims on expired leases so the worker can re-claim them.
    if (expiredLeases.length > 0) {
      await db
        .update(recipients)
        .set({
          status: "queued",
          claimedBy: null,
          claimExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          inArray(
            recipients.id,
            expiredLeases.map((r) => r.id),
          ),
        );
    }

    // 3. Sender per schedule, needed to build a valid job payload.
    const scheduleIds = [...new Set(candidates.map((c) => c.scheduleId))];
    const scheduleRows = await db
      .select({
        id: schedules.id,
        senderId: sql<string>`(
          SELECT id FROM senders
          WHERE senders.owner_id = ${schedules.ownerId}
          ORDER BY senders.created_at ASC
          LIMIT 1
        )`.as("senderId"),
      })
      .from(schedules)
      .where(inArray(schedules.id, scheduleIds));

    const senderBySchedule = new Map(
      scheduleRows.map((row) => [row.id, row.senderId as string | null]),
    );

    // 4. Idempotent publication — a job that still exists is left alone.
    const existing = await emailQueue.getJobs([
      "waiting",
      "delayed",
      "active",
      "paused",
      "wait",
    ]);
    const liveJobIds = new Set(existing.map((j) => j.id));

    let enqueued = 0;
    for (const candidate of candidates) {
      // Must match the publisher's delimiter exactly or reconciliation would
      // duplicate work that the scheduler already queued.
      const jobId = `recipient-${candidate.id}-1`;
      if (liveJobIds.has(jobId)) continue;

      const senderId = senderBySchedule.get(candidate.scheduleId);
      if (!senderId) {
        log.warn(
          { scheduleId: candidate.scheduleId, recipientId: candidate.id },
          "No sender for schedule, skipping reconciliation",
        );
        continue;
      }

      // republishEmailJob replaces a dead entry, so a job that crashed in
      // BullMQ while the recipient stayed `queued` is retried rather than
      // being silently skipped by a duplicate job id.
      const published = await republishEmailJob(
        jobId,
        {
          recipientId: candidate.id,
          scheduleId: candidate.scheduleId,
          senderId,
          attempt: 1,
        },
        candidate.scheduledAt.getTime() - Date.now(),
      );

      if (published) enqueued++;
    }

    metrics.reconciliationScans.inc();
    metrics.reconciliationEnqueued.inc(enqueued);

    log.info({ enqueued, scanned: candidates.length }, "Reconciliation complete");
  } catch (error) {
    log.error({ err: error }, "Reconciliation failed");
  } finally {
    await republishPendingOutbox();
  }
}

/**
 * Recompute the status of any schedule that is not terminal but whose
 * recipients all are.
 *
 * Without this, a schedule whose last worker died between writing a recipient
 * and rolling up the parent would sit in `queued` forever, and the dashboard
 * would claim a finished campaign was still waiting. Bounded so a large
 * backlog of stuck rows cannot turn a 60-second scan into a long query.
 */
async function repairScheduleStatuses(): Promise<void> {
  try {
    const stuck = await db
      .selectDistinct({ id: schedules.id })
      .from(schedules)
      .innerJoin(recipients, eq(recipients.scheduleId, schedules.id))
      .where(
        and(
          inArray(schedules.status, ["scheduled", "queued", "sending"]),
          sql`NOT EXISTS (
            SELECT 1 FROM recipients r
            WHERE r.schedule_id = ${schedules.id}
              AND r.status NOT IN ('sent', 'failed', 'cancelled')
          )`,
        ),
      )
      .limit(BATCH_SIZE);

    if (stuck.length === 0) return;

    let repaired = 0;
    for (const row of stuck) {
      const changed = await refreshScheduleStatus(row.id);
      if (changed) repaired++;
    }

    if (repaired > 0) {
      logger.info({ repaired }, "Repaired schedule statuses from recipients");
    }
  } catch (error) {
    logger.error({ err: error }, "Schedule status repair failed");
  }
}

/**
 * Re-publish outbox events left `pending`, covering the window where the DB
 * commit succeeded but queue publication failed.
 */
async function republishPendingOutbox(): Promise<void> {
  try {
    const pending = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.status, "pending"),
          lt(outboxEvents.attempts, 5),
        ),
      )
      .limit(BATCH_SIZE);

    if (pending.length > 0) {
      await enqueueOutboxEvent(pending.map((e) => e.id));
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to republish pending outbox events");
  }
}
