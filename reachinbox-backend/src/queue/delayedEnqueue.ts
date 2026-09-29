import { emailQueue } from "./connection.js";
import { logger } from "../observability/logger.js";
import { DependencyError } from "../domain/errors.js";

/**
 * BullMQ's shared connection uses `maxRetriesPerRequest: null`, which BullMQ
 * requires of worker connections but which makes *publisher* commands queue
 * forever when Redis is unreachable. Without this guard a schedule request
 * hangs indefinitely instead of failing, so the caller never learns that
 * publication did not happen.
 */
const PUBLISH_TIMEOUT_MS = Number(process.env.QUEUE_PUBLISH_TIMEOUT_MS ?? 5_000);

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new DependencyError(
          `Queue publication timed out after ${PUBLISH_TIMEOUT_MS}ms (${label})`,
        ),
      );
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

export interface DelayedJobData {
  name: string;
  data: Record<string, unknown>;
  delay: number;
  jobId: string;
}

export async function enqueueDelayedJob(job: DelayedJobData): Promise<void> {
  try {
    await withTimeout(
      emailQueue.add(job.name, job.data, {
        delay: job.delay,
        jobId: job.jobId,
        removeOnComplete: true,
        removeOnFail: false,
      }),
      job.jobId,
    );
    logger.debug({ jobId: job.jobId, delay: job.delay }, "Enqueued delayed job");
  } catch (error) {
    // Rethrown: durable state is already committed, so reconciliation will
    // re-publish, but the caller must know publication did not happen.
    logger.error(
      {
        err: error,
        jobId: job.jobId,
        reason: error instanceof Error ? error.message : String(error),
      },
      "Failed to enqueue delayed job",
    );
    throw error;
  }
}
