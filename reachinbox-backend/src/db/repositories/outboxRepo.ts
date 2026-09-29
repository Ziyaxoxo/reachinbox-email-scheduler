import { db } from "../client.js";
import { outboxEvents } from "../schema.js";
import { eq, and, lt } from "drizzle-orm";

export async function createOutboxEvent(event: {
  type: string;
  aggregateId: string;
  payload: unknown;
}) {
  await db.insert(outboxEvents).values({
    type: event.type as never,
    aggregateId: event.aggregateId,
    payload: event.payload,
    status: "pending",
  });
}

export async function findPendingOutboxEvents(limit = 100) {
  return db.query.outboxEvents.findMany({
    where: and(
      eq(outboxEvents.status, "pending"),
      lt(outboxEvents.attempts, 5),
    ),
    limit,
  });
}

export async function markOutboxEventProcessing(id: string) {
  await db
    .update(outboxEvents)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(outboxEvents.id, id));
}

export async function markOutboxEventCompleted(id: string) {
  await db
    .update(outboxEvents)
    .set({ status: "completed", processedAt: new Date(), updatedAt: new Date() })
    .where(eq(outboxEvents.id, id));
}

export async function markOutboxEventFailed(id: string, error: string) {
  const event = await db.query.outboxEvents.findFirst({
    where: eq(outboxEvents.id, id),
  });

  if (!event) return;

  const attempts = event.attempts + 1;
  await db
    .update(outboxEvents)
    .set({
      status: attempts >= 5 ? "failed" : "pending",
      attempts,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(eq(outboxEvents.id, id));
}
