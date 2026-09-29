import { Worker, Job } from "bullmq";
import { emailQueue, redisConnection } from "../queue/connection.js";
import { db } from "../db/client.js";
import { recipients, deliveryAttempts, schedules, senders } from "../db/schema.js";
import { eq, and, or, lt } from "drizzle-orm";
import { getSmtpTransport } from "../services/smtp/transportFactory.js";
import {
  reserveHourlyCapacity,
  advanceSenderDelay,
  releaseHourlyCapacity,
  peekSenderDelay,
} from "../services/rateLimiter.js";
import { recordRateLimitEvent } from "../services/slack/rateLimitEvents.js";
import { enqueueOutboxEvent } from "../queue/outboxPublisher.js";
import { logger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";
import { env } from "../config/env.js";
import { isTerminalRecipientStatus } from "../domain/stateMachine.js";
import { refreshScheduleStatus } from "../db/repositories/scheduleRepo.js";
import { registerWorker } from "./gracefulShutdown.js";

const smtpTransport = getSmtpTransport();

const CLAIM_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/**
 * Job id for a deferred send.
 *
 * A deferral re-enqueues while the current job is still active, so reusing the
 * current job id would be silently ignored by BullMQ (duplicate id) and the
 * message would only be recovered by the 60s reconciliation sweep. A unique
 * suffix makes the deferral take effect at the intended time.
 */
function deferralJobId(recipientId: string, attempt: number): string {
  return `recipient-${recipientId}-${attempt}-d${Date.now()}`;
}

interface EmailJobData {
  recipientId: string;
  scheduleId: string;
  senderId: string;
  attempt: number;
  correlationId?: string;
}

export const emailWorker = new Worker<EmailJobData>(
  "email-scheduling",
  async (job: Job<EmailJobData>) => {
    const { recipientId, scheduleId, senderId, attempt } = job.data;
    const log = logger.child({
      jobId: job.id,
      recipientId,
      scheduleId,
      correlationId: job.data.correlationId,
    });

    // 1. Authoritative state. The queue is execution, the DB is truth.
    const recipient = await db.query.recipients.findFirst({
      where: eq(recipients.id, recipientId),
    });

    if (!recipient) {
      log.warn("Recipient not found, dropping job");
      return;
    }

    // Terminal history is never re-sent, regardless of why the job exists.
    if (isTerminalRecipientStatus(recipient.status)) {
      log.info({ status: recipient.status }, "Recipient terminal, skipping send");
      return;
    }

    // A previous attempt already completed the SMTP side effect. Without this,
    // a redelivered job after a post-send crash would send twice.
    const priorAccepted = await db.query.deliveryAttempts.findFirst({
      where: and(
        eq(deliveryAttempts.recipientId, recipientId),
        eq(deliveryAttempts.attempt, attempt),
      ),
    });

    if (priorAccepted?.providerId) {
      log.info(
        { attempt, providerId: priorAccepted.providerId },
        "Attempt already accepted by provider, marking sent without resending",
      );
      await db
        .update(recipients)
        .set({ status: "sent", updatedAt: new Date() })
        .where(eq(recipients.id, recipientId));
      return;
    }

    // 2. Claim via compare-and-set. The WHERE clause is the concurrency
    // boundary: only one worker can move queued -> sending.
    const claim = await db
      .update(recipients)
      .set({
        status: "sending",
        claimedBy: job.id ?? "unknown",
        claimExpiresAt: new Date(Date.now() + CLAIM_TTL_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recipients.id, recipientId),
          or(
            eq(recipients.status, "queued"),
            and(
              eq(recipients.status, "sending"),
              lt(recipients.claimExpiresAt, new Date()),
            ),
          ),
        ),
      )
      .returning();

    if (claim.length === 0) {
      metrics.workerClaimsLost.inc();
      log.info(
        { status: recipient.status },
        "Claim lost to another worker, skipping",
      );
      return;
    }

    const schedule = await db.query.schedules.findFirst({
      where: eq(schedules.id, scheduleId),
    });
    if (!schedule) {
      await failRecipient(recipientId, "Schedule missing");
      return;
    }

    const sender = await db.query.senders.findFirst({
      where: eq(senders.id, senderId),
    });
    if (!sender || sender.status !== "active") {
      await failRecipient(recipientId, "Sender unavailable");
      return;
    }

    // The recipient is claimed and in flight, so the parent is `sending`. Done
    // before the SMTP contact so a slow or hanging provider still shows the
    // campaign as actively delivering rather than merely queued.
    await refreshScheduleStatus(scheduleId);

    // 3. Cheap gate first: if the sender is still inside its minimum-delay
    //    window, defer without touching hourly capacity. Reserving an hourly
    //    slot for work that cannot send yet inflates the window counter and can
    //    push unrelated recipients past the limit into the next hour.
    if (schedule.delayMs > 0) {
      const peek = await peekSenderDelay(sender.id);

      if (!peek.eligible) {
        log.info({ waitMs: peek.waitMs }, "Sender delay pending, deferring");

        await db
          .update(recipients)
          .set({ status: "queued", updatedAt: new Date() })
          .where(eq(recipients.id, recipientId));

        await emailQueue.add("send-email", job.data, {
          delay: Math.max(1, peek.waitMs),
          jobId: deferralJobId(recipientId, attempt),
        });
        return;
      }
    }

    // 4. Reserve hourly capacity before any SMTP contact.
    const hourly = await reserveHourlyCapacity(sender.id, schedule.hourlyLimit);

    if (!hourly.allowed) {
      log.info(
        { currentCount: hourly.currentCount, limit: hourly.limit },
        "Hourly capacity exhausted, deferring to next window",
      );

      // Durable event, not a direct call: Slack failure must never affect
      // email delivery, and dedupe happens on the event.
      await recordRateLimitEvent({
        ownerId: schedule.ownerId,
        senderId: sender.id,
        senderEmail: sender.email,
        hourlyLimit: schedule.hourlyLimit,
        windowStart: hourly.windowStart,
      });

      const delay = Math.max(1000, hourly.nextWindowStart.getTime() - Date.now());

      await db
        .update(recipients)
        .set({ status: "queued", scheduledAt: hourly.nextWindowStart, updatedAt: new Date() })
        .where(eq(recipients.id, recipientId));

      await emailQueue.add("send-email", job.data, {
        delay,
        jobId: deferralJobId(recipientId, attempt),
      });
      return;
    }

    // 5. Take the minimum-delay slot. Losing this race after the peek is
    //    possible under contention, so the hourly slot is handed back rather
    //    than leaked.
    const delayResult = await advanceSenderDelay(sender.id, schedule.delayMs);

    if (!delayResult.allowed) {
      log.info({ waitMs: delayResult.waitMs }, "Sender delay lost race, deferring");

      await releaseHourlyCapacity(sender.id, hourly.windowStart);

      await db
        .update(recipients)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(recipients.id, recipientId));

      await emailQueue.add("send-email", job.data, {
        delay: Math.max(1, delayResult.waitMs),
        jobId: deferralJobId(recipientId, attempt),
      });
      return;
    }

    // 5. SMTP send.
    const startedAt = Date.now();

    try {
      const result = await smtpTransport.send({
        from: sender.email,
        to: recipient.normalizedEmail,
        subject: schedule.subject,
        body: schedule.body,
      });

      metrics.emailSendDuration.observe(
        { sender: sender.email, status: "success" },
        (Date.now() - startedAt) / 1000,
      );
      metrics.emailsSent.inc({ sender: sender.email });

      // Attempt row is written before the recipient flips to sent, so a crash
      // between the two leaves an accepted attempt that the guard above detects.
      await db.insert(deliveryAttempts).values({
        recipientId,
        attempt,
        providerId: result.providerId,
        sentAt: new Date(),
      });

      await db
        .update(recipients)
        .set({ status: "sent", updatedAt: new Date() })
        .where(eq(recipients.id, recipientId));

      await refreshScheduleStatus(scheduleId);

      // Derived read-model update, published outbox-style.
      await enqueueOutboxEventForRecipient({
        recipientId,
        scheduleId: schedule.id,
        ownerId: schedule.ownerId,
        subject: schedule.subject,
        normalizedEmail: recipient.normalizedEmail,
        status: "sent",
        attempt,
        providerId: result.providerId,
        scheduledAt: recipient.scheduledAt,
      });

      log.info({ providerId: result.providerId }, "Email sent");
    } catch (error) {
      metrics.emailSendDuration.observe(
        { sender: sender.email, status: "failed" },
        (Date.now() - startedAt) / 1000,
      );

      const err = error as {
        code?: string;
        message?: string;
        classification?: "transient" | "permanent" | "ambiguous";
      };

      // A pre-send failure gives the slot back. An ambiguous failure (connection
      // lost after the provider may have accepted) keeps the slot, because we
      // cannot prove the message was not delivered.
      if (err.classification !== "ambiguous") {
        await releaseHourlyCapacity(sender.id, hourly.windowStart);
      }

      await db.insert(deliveryAttempts).values({
        recipientId,
        attempt,
        failureCode: err.code ?? "UNKNOWN",
        failureMessage: err.message ?? "Unknown error",
        // providerId stays null; an ambiguous attempt is recorded explicitly
        // rather than being silently retried.
        sentAt: err.classification === "ambiguous" ? new Date() : null,
      });

      const retryable = err.classification === "transient" && attempt < MAX_ATTEMPTS;

      if (retryable) {
        log.warn({ attempt, code: err.code }, "Transient failure, retrying");

        await db
          .update(recipients)
          .set({ status: "queued", updatedAt: new Date() })
          .where(eq(recipients.id, recipientId));

        await emailQueue.add(
          "send-email",
          { ...job.data, attempt: attempt + 1 },
          {
            delay: 5000 * attempt,
            jobId: `recipient-${recipientId}-${attempt + 1}`,
          },
        );
      } else {
        metrics.emailsFailed.inc({
          sender: sender.email,
          kind: err.classification ?? "permanent",
        });
        log.error({ attempt, code: err.code, kind: err.classification }, "Terminal failure");
        await failRecipient(recipientId, err.code ?? "UNKNOWN");
      }
    }
  },
  {
    connection: redisConnection,
    concurrency: env.WORKER_CONCURRENCY,
  },
);

/**
 * Move a recipient to terminal failure. The recipient row is the audit record;
 * the specific error code is already captured on the delivery attempt.
 */
async function failRecipient(recipientId: string, _code: string) {
  await db
    .update(recipients)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(recipients.id, recipientId));

  // The last recipient failing is what makes a campaign `failed`, so the parent
  // has to be rolled up here as well as on the success path.
  const row = await db.query.recipients.findFirst({
    where: eq(recipients.id, recipientId),
    columns: { scheduleId: true },
  });
  if (row) await refreshScheduleStatus(row.scheduleId);
}

async function enqueueOutboxEventForRecipient(input: {
  recipientId: string;
  scheduleId: string;
  ownerId: string;
  subject: string;
  normalizedEmail: string;
  status: string;
  attempt: number;
  providerId: string;
  scheduledAt: Date;
}) {
  const { db: database } = await import("../db/client.js");
  const { outboxEvents } = await import("../db/schema.js");

  const [row] = await database
    .insert(outboxEvents)
    .values({
      type: "email.indexed",
      aggregateId: input.recipientId,
      payload: {
        ...input,
        sentAt: new Date(),
        createdAt: new Date(),
      },
      status: "pending",
    })
    .returning({ id: outboxEvents.id });

  if (row) await enqueueOutboxEvent([row.id]);
}

emailWorker.on("completed", (job) => {
  logger.debug({ jobId: job.id }, "Email job completed");
});

emailWorker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, err: error }, "Email job failed");
});

// Registered for graceful shutdown; the module is only imported in worker mode.
registerWorker(emailWorker);
