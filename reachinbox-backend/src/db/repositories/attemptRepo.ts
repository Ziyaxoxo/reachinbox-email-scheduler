import { db } from "../client.js";
import { deliveryAttempts } from "../schema.js";
import { eq, desc } from "drizzle-orm";

export async function recordAttempt(attempt: {
  recipientId: string;
  attempt: number;
  providerId?: string;
  sentAt?: Date;
  failureCode?: string;
  failureMessage?: string;
}) {
  await db.insert(deliveryAttempts).values({
    recipientId: attempt.recipientId,
    attempt: attempt.attempt,
    providerId: attempt.providerId || null,
    sentAt: attempt.sentAt || null,
    failureCode: attempt.failureCode || null,
    failureMessage: attempt.failureMessage || null,
  });
}

export async function findAttemptsByRecipient(recipientId: string) {
  return db.query.deliveryAttempts.findMany({
    where: eq(deliveryAttempts.recipientId, recipientId),
    orderBy: [desc(deliveryAttempts.attempt)],
  });
}
