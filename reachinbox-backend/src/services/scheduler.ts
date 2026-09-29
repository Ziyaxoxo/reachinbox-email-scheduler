import { nanoid } from "nanoid";
import { db } from "../db/client.js";
import {
  schedules,
  recipients as recipientsTable,
  outboxEvents,
  senders,
  users,
} from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { enqueueDelayedJob } from "../queue/delayedEnqueue.js";
import { enqueueOutboxEvent } from "../queue/outboxPublisher.js";
import { sanitizeEmailBody } from "./sanitize/html.js";
import { logger } from "../observability/logger.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";

/**
 * How far in the past a start time may be and still be accepted.
 *
 * Small but not zero: clients submit whole minutes, so a user picking the
 * current minute is legitimately a few seconds behind. Anything older than this
 * is a real request to schedule something that has already passed, which would
 * send immediately and quietly turn a scheduled campaign into an instant one.
 */
const START_AT_PAST_GRACE_MS = 60_000;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "23505"
  );
}

export interface CreateScheduleInput {
  ownerId: string;
  subject: string;
  body: string;
  recipients: string[];
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
  idempotencyKey?: string;
  correlationId: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createSchedule(input: CreateScheduleInput) {
  const {
    ownerId,
    subject,
    body,
    recipients,
    startAt,
    delayMs,
    hourlyLimit,
    idempotencyKey,
    correlationId,
  } = input;

  const key = idempotencyKey?.trim() || nanoid();

  // Checked before the idempotency replay lookup on purpose: a replay of an
  // already-accepted key must keep returning the original resource even once
  // its start time is in the past, or a client retrying a successful create
  // after a network blip would be told its request was invalid.
  const startAtMs = startAt.getTime();
  if (Number.isNaN(startAtMs)) {
    throw new ValidationError("startAt must be a valid date");
  }
  if (startAtMs < Date.now() - START_AT_PAST_GRACE_MS) {
    throw new ValidationError("startAt must not be in the past", {
      startAt: startAt.toISOString(),
    });
  }

  // The browser is not the security boundary: a direct API caller can post
  // arbitrary markup, and the stored body is rendered in mail clients.
  const { html: safeBody, modified: bodyStripped } = sanitizeEmailBody(body);

  if (bodyStripped) {
    logger.warn(
      { correlationId, scheduleKey: key },
      "Email body contained disallowed markup, which was removed",
    );
  }

  // Idempotency is scoped to the owner: replaying the same logical request from
  // the same owner returns the original resource; a different owner is free to
  // use the same key because the unique index is (ownerId, idempotencyKey).
  const existing = await db.query.schedules.findFirst({
    where: and(eq(schedules.ownerId, ownerId), eq(schedules.idempotencyKey, key)),
  });

  if (existing) {
    logger.info(
      { scheduleId: existing.id, correlationId },
      "Replaying schedule for existing idempotency key",
    );
    return {
      id: existing.id,
      status: existing.status,
      createdAt: existing.createdAt,
      idempotencyKey: existing.idempotencyKey,
      replayed: true,
    };
  }

  // Normalize and deduplicate recipients
  const seen = new Set<string>();
  const normalizedRecipients: string[] = [];
  for (const email of recipients) {
    const normalized = normalizeEmail(email);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      normalizedRecipients.push(normalized);
    }
  }

  // Get or create sender for this owner
  let sender = await db.query.senders.findFirst({
    where: eq(senders.ownerId, ownerId),
  });

  if (!sender) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, ownerId),
    });
    if (!user) throw new NotFoundError("User not found");

    const newSender = await db
      .insert(senders)
      .values({
        ownerId,
        email: user.email,
        transportRef: "ethereal",
        status: "active",
      })
      .returning();
    sender = newSender[0]!;
  }

  // Create schedule and recipients in a transaction.
  // If a concurrent request wins the (ownerId, idempotencyKey) unique index
  // race, we replay that resource instead of surfacing a 500.
  // Recipients are written as `queued` so the worker's compare-and-set claim
  // (WHERE status = 'queued') can succeed. Durable DB state is written before
  // any queue publication, so an enqueue failure is recoverable by reconciliation.
  type CreatedRecipient = {
    id: string;
    normalizedEmail: string;
    scheduledAt: Date;
  };
  type CreationResult = { schedule: typeof schedules.$inferSelect; createdRecipients: CreatedRecipient[] };
  let result: CreationResult;

  try {
    result = await db.transaction(async (tx) => {
    const [newSchedule] = await tx
      .insert(schedules)
      .values({
        ownerId,
        subject,
        body: safeBody,
        startAt,
        delayMs,
        hourlyLimit,
        status: "queued",
        idempotencyKey: key,
      })
      .returning();

    if (!newSchedule) throw new Error("Failed to create schedule");

    const recipientRows = normalizedRecipients.map((email, index) => ({
      scheduleId: newSchedule.id,
      normalizedEmail: email,
      sequenceNo: index + 1,
      scheduledAt: new Date(startAt.getTime() + index * delayMs),
      status: "queued" as const,
    }));

    const insertedRecipients = await tx
      .insert(recipientsTable)
      .values(recipientRows)
      .returning({
        id: recipientsTable.id,
        normalizedEmail: recipientsTable.normalizedEmail,
        scheduledAt: recipientsTable.scheduledAt,
      });

    // Transactional outbox: ES indexing is a derived side effect, recorded in the
    // same transaction as the business state and dispatched by the outbox worker.
    await tx.insert(outboxEvents).values(
      insertedRecipients.map((r) => ({
        type: "email.indexed" as const,
        aggregateId: r.id,
        payload: {
          recipientId: r.id,
          scheduleId: newSchedule.id,
          ownerId,
          subject,
          normalizedEmail: r.normalizedEmail,
          status: "queued",
        },
        status: "pending" as const,
      })),
    );

    return { schedule: newSchedule, createdRecipients: insertedRecipients };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const winner = await db.query.schedules.findFirst({
      where: and(eq(schedules.ownerId, ownerId), eq(schedules.idempotencyKey, key)),
    });
    if (!winner) throw error;

    logger.info(
      { scheduleId: winner.id, correlationId },
      "Concurrent idempotent request replayed existing schedule",
    );
    return {
      id: winner.id,
      status: winner.status,
      createdAt: winner.createdAt,
      idempotencyKey: winner.idempotencyKey,
      replayed: true,
    };
  }

  const { schedule, createdRecipients } = result;

  // Idempotent publication: jobId is derived from the real recipient UUID, so a
  // duplicate enqueue (retry, reconciliation, crash) resolves to the same job.
  for (const recipient of createdRecipients) {
    const delay = Math.max(0, recipient.scheduledAt.getTime() - Date.now());

    await enqueueDelayedJob({
      name: "send-email",
      data: {
        recipientId: recipient.id,
        scheduleId: schedule.id,
        senderId: sender.id,
        attempt: 1,
        correlationId,
      },
      delay,
      // Dash delimiter: BullMQ rejects some colon-bearing custom job ids.
      jobId: `recipient-${recipient.id}-1`,
    });
  }

  // Publish outbox events to the dispatcher queue. Publication is at-least-once
  // and the dispatcher de-duplicates on the event id, so a partial failure here
  // is safe: the reconciliation scanner re-publishes anything left `pending`.
  await enqueueOutboxEvent(createdRecipients.map((r) => r.id));

  logger.info(
    {
      scheduleId: schedule.id,
      recipientCount: createdRecipients.length,
      correlationId,
    },
    "Schedule created successfully",
  );

  return {
    id: schedule.id,
    status: schedule.status,
    createdAt: schedule.createdAt,
    idempotencyKey: schedule.idempotencyKey,
    replayed: false,
  };
}
