import { Worker, Job } from "bullmq";
import { redisConnection } from "../queue/connection.js";
import { db } from "../db/client.js";
import { outboxEvents } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { indexEmailRecord } from "../services/elasticsearch/indexer.js";
import { sendSlackRateLimitEvent } from "../services/slack/notifier.js";
import { logger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";
import { registerWorker } from "./gracefulShutdown.js";

const MAX_ATTEMPTS = 5;

interface OutboxJobData {
  eventId: string;
}

export const outboxWorker = new Worker<OutboxJobData>(
  "outbox-events",
  async (job: Job<OutboxJobData>) => {
    const { eventId } = job.data;
    const log = logger.child({ jobId: job.id, eventId });

    // Claim the event so two workers cannot dispatch the same event.
    const claimed = await db
      .update(outboxEvents)
      .set({ status: "processing", updatedAt: new Date() })
      .where(
        and(
          eq(outboxEvents.id, eventId),
          eq(outboxEvents.status, "pending"),
        ),
      )
      .returning();

    if (claimed.length === 0) {
      log.debug("Outbox event already claimed or completed, skipping");
      return;
    }

    const event = claimed[0]!;

    try {
      await dispatch(event.type, event.payload);

      await db
        .update(outboxEvents)
        .set({
          status: "completed",
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(outboxEvents.id, eventId));

      metrics.outboxEvents.inc({ type: event.type, status: "completed" });
    } catch (error) {
      const attempts = event.attempts + 1;
      const message = error instanceof Error ? error.message : "Unknown error";

      await db
        .update(outboxEvents)
        .set({
          // Exhausted events return to pending-safe `failed`; the scanner
          // retries anything still below the ceiling.
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          lastError: message.slice(0, 2000),
          updatedAt: new Date(),
        })
        .where(eq(outboxEvents.id, eventId));

      metrics.outboxEvents.inc({ type: event.type, status: "failed" });
      log.error({ err: error, attempts }, "Outbox dispatch failed");

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 3,
  },
);

async function dispatch(
  type: string,
  payload: unknown,
): Promise<void> {
  if (type === "email.indexed") {
    const p = payload as {
      recipientId: string;
      scheduleId: string;
      ownerId: string;
      subject: string;
      normalizedEmail: string;
      status: string;
      attempt?: number;
      providerId?: string;
      scheduledAt?: Date | string;
      sentAt?: Date | string;
      createdAt?: Date | string;
    };

    // Document id is the recipient UUID, so replaying an event updates the
    // same document rather than creating a duplicate.
    await indexEmailRecord({
      recipientId: p.recipientId,
      scheduleId: p.scheduleId,
      ownerId: p.ownerId,
      normalizedEmail: p.normalizedEmail,
      subject: p.subject,
      status: p.status,
      attempt: p.attempt,
      providerId: p.providerId,
      scheduledAt: toDate(p.scheduledAt) ?? new Date(),
      sentAt: toDate(p.sentAt),
      createdAt: toDate(p.createdAt) ?? new Date(),
    });
    return;
  }

  if (type === "slack.rate_limit") {
    const p = payload as {
      ownerId: string;
      senderEmail: string;
      hourlyLimit: number;
    };

    await sendSlackRateLimitEvent(p.ownerId, p.senderEmail, p.hourlyLimit);
    return;
  }

  logger.warn({ type }, "Unknown outbox event type, ignoring");
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

outboxWorker.on("completed", (job) => {
  logger.debug({ jobId: job.id }, "Outbox job completed");
});

outboxWorker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, err: error }, "Outbox job failed");
});

registerWorker(outboxWorker);
