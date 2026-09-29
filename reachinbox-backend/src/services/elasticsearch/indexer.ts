import { indexEmailRecord } from "./client.js";

export interface EmailIndexRecord {
  recipientId: string;
  scheduleId: string;
  ownerId: string;
  normalizedEmail: string;
  subject: string;
  status: string;
  attempt?: number;
  providerId?: string | null;
  scheduledAt: Date;
  sentAt?: Date | null;
  createdAt: Date;
}

export { indexEmailRecord };

/**
 * Index one recipient-level document.
 *
 * Document id is the recipient UUID, so replaying an outbox event converges on
 * the same document instead of duplicating business records.
 */
export async function indexRecipientRecord(record: EmailIndexRecord): Promise<void> {
  await indexEmailRecord(record);
}

/**
 * Search the derived read model.
 *
 * Exposed for support tooling and future read paths. Elasticsearch remains
 * non-authoritative: an outage here never blocks or mutates business state.
 */
export async function searchEmailIndex(params: {
  ownerId: string;
  query?: string;
  status?: string;
  page?: number;
  limit?: number;
}) {
  const { searchEmails } = await import("./client.js");
  return searchEmails({
    ownerId: params.ownerId,
    query: params.query,
    status: params.status,
    page: params.page ?? 1,
    limit: Math.min(params.limit ?? 20, 100),
  });
}
