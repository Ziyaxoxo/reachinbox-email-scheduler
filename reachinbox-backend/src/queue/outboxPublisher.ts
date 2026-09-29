import { outboxQueue, emailQueue } from "./connection.js";
import type { Job, Queue } from "bullmq";
import { logger } from "../observability/logger.js";

/**
 * Re-publish a job that may already exist as a dead entry.
 *
 * BullMQ silently ignores an `add()` whose `jobId` is already held by a job in
 * the `failed` or `completed` set. That makes a deterministic job id a trap for
 * recovery: a dispatch that exhausts its retries returns the *database* row to
 * `pending`, but every later republication is dropped on the floor and the
 * event is stranded forever.
 *
 * Live jobs (waiting/delayed/active/paused) are left alone, which is what keeps
 * republication idempotent for the common duplicate-publication case.
 */
export async function republishDeadJob<T>(
  queue: Queue<T>,
  jobId: string,
): Promise<boolean> {
  const existing = (await queue.getJob(jobId)) as Job<T> | undefined;

  if (!existing) return true;

  const state = await existing.getState();

  if (state === "failed" || state === "completed") {
    await existing.remove().catch((error: unknown) => {
      logger.debug({ err: error, jobId }, "Could not remove dead job; skipping");
    });
    return true;
  }

  // waiting | delayed | active | paused — already scheduled, nothing to do.
  return false;
}

/**
 * Publish outbox events to the dispatcher queue.
 *
 * Publication is at-least-once and the dispatcher is idempotent on the event id,
 * so a partial failure here is safe: anything still `pending` is re-published by
 * the reconciliation scanner.
 */
/**
 * See `enqueueDelayedJob`: the shared BullMQ connection retries forever, so
 * publisher calls are bounded explicitly. Outbox publication is best effort by
 * design — the event stays `pending` and reconciliation re-publishes it.
 */
const PUBLISH_TIMEOUT_MS = Number(process.env.QUEUE_PUBLISH_TIMEOUT_MS ?? 5_000);

function withPublishTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Outbox publish timed out for ${label}`));
    }, PUBLISH_TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function enqueueOutboxEvent(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;

  const results = await Promise.allSettled(
    eventIds.map(async (eventId) => {
      const jobId = `outbox-${eventId}`;

      const publishable = await withPublishTimeout(
        republishDeadJob(outboxQueue, jobId),
        jobId,
      );
      if (!publishable) return;

      await withPublishTimeout(
        outboxQueue.add(
          "dispatch-outbox",
          { eventId },
          {
            // Dash delimiter — BullMQ rejects some colon-bearing custom ids.
            jobId,
            removeOnComplete: 500,
            removeOnFail: 1000,
          },
        ),
        jobId,
      );
    }),
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    logger.warn(
      {
        failed: failed.length,
        total: eventIds.length,
        reason: failed[0]?.status === "rejected" ? String(failed[0].reason) : undefined,
      },
      "Some outbox events failed to publish",
    );
  }
}

/**
 * Re-publish a recipient send job, replacing a dead entry if one exists.
 *
 * Same rationale as {@link enqueueOutboxEvent}: if a job died in BullMQ while
 * the recipient remained `queued` in the database, republication must be able to
 * reclaim the id or the message is never retried.
 */
export async function republishEmailJob(
  jobId: string,
  data: Record<string, unknown>,
  delay: number,
): Promise<boolean> {
  const publishable = await withPublishTimeout(
    republishDeadJob(emailQueue, jobId),
    jobId,
  );
  if (!publishable) return false;

  await withPublishTimeout(
    emailQueue.add("send-email", data, {
      delay: Math.max(0, delay),
      jobId,
      removeOnComplete: 100,
      removeOnFail: 500,
    }),
    jobId,
  );

  return true;
}
