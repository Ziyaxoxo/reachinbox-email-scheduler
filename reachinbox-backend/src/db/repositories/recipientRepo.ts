import { db } from "../client.js";
import { recipients } from "../schema.js";
import { eq, and, lte, inArray } from "drizzle-orm";

export async function findRecipientById(id: string) {
  return db.query.recipients.findFirst({
    where: eq(recipients.id, id),
  });
}

export async function findPendingRecipients(limit = 1000) {
  return db.query.recipients.findMany({
    where: and(
      inArray(recipients.status, ["scheduled", "queued"]),
      lte(recipients.scheduledAt, new Date()),
    ),
    limit,
  });
}

export async function claimRecipient(id: string, jobId: string) {
  const result = await db
    .update(recipients)
    .set({
      status: "sending",
      claimedBy: jobId,
      claimExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recipients.id, id),
        eq(recipients.status, "queued"),
      ),
    )
    .returning();

  return result.length > 0;
}

export async function updateRecipientStatus(id: string, status: string) {
  await db
    .update(recipients)
    .set({ status: status as never, updatedAt: new Date() })
    .where(eq(recipients.id, id));
}
