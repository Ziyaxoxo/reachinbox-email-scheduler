import { db } from "../client.js";
import { slackConnections } from "../schema.js";
import { eq } from "drizzle-orm";

export async function findSlackConnectionByOwner(ownerId: string) {
  return db.query.slackConnections.findFirst({
    where: eq(slackConnections.ownerId, ownerId),
  });
}

export async function createOrUpdateSlackConnection(connection: {
  ownerId: string;
  workspaceId: string;
  destinationRef: string;
  encryptedSecretRef: string;
}) {
  await db
    .insert(slackConnections)
    .values({
      ...connection,
      status: "connected",
    })
    .onConflictDoUpdate({
      target: slackConnections.ownerId,
      set: {
        workspaceId: connection.workspaceId,
        destinationRef: connection.destinationRef,
        encryptedSecretRef: connection.encryptedSecretRef,
        status: "connected",
        updatedAt: new Date(),
      },
    });
}

export async function disconnectSlackConnection(ownerId: string) {
  await db
    .update(slackConnections)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(eq(slackConnections.ownerId, ownerId));
}
