import { emailQueue, outboxQueue } from "../queue/connection.js";
import { metrics } from "./metrics.js";
import { logger } from "./logger.js";

const QUEUES = [
  { name: "email-scheduling", queue: emailQueue },
  { name: "outbox-events", queue: outboxQueue },
] as const;

const STATES = ["waiting", "active", "delayed", "completed", "failed"] as const;

/**
 * Sample queue depths so BE-OBS-002 metrics exist even though worker processes
 * expose no HTTP endpoint. Failures are swallowed: metrics must never take a
 * worker down.
 */
export async function refreshQueueDepthMetrics(): Promise<void> {
  for (const { name, queue } of QUEUES) {
    try {
      const counts = await queue.getJobCounts(...STATES);
      for (const state of STATES) {
        metrics.queueDepth.set({ queue: name, status: state }, counts[state] ?? 0);
      }
    } catch (error) {
      logger.debug({ err: error, queue: name }, "Queue depth sample failed");
    }
  }
}
