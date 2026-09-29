import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { outboxEvents, deliveryAttempts, recipients, schedules } from "../db/schema.js";
import { logger } from "../observability/logger.js";

/**
 * Retention policy (BE-SEC-007).
 *
 * Recipient addresses, message bodies and attempt audit rows are operational
 * data with a bounded lifetime:
 *
 *  - Completed delivery attempts: RETENTION_ATTEMPT_DAYS (default 90)
 *  - Terminal recipients + their attempts: RETENTION_RECIPIENT_DAYS (default 180)
 *  - Superseded outbox events: RETENTION_OUTBOX_DAYS (default 30)
 *
 * The window is deliberately long enough for support investigations and short
 * enough that recipient PII does not persist indefinitely. Schedules are kept
 * for the full period because they carry the audit trail for the business
 * operation itself; their `body` is cleared once all recipients are terminal.
 */
const ATTEMPT_DAYS = Number(process.env.RETENTION_ATTEMPT_DAYS ?? 90);
const RECIPIENT_DAYS = Number(process.env.RETENTION_RECIPIENT_DAYS ?? 180);
const OUTBOX_DAYS = Number(process.env.RETENTION_OUTBOX_DAYS ?? 30);

const BATCH = 5000;

export interface RetentionReport {
  attemptsDeleted: number;
  recipientsDeleted: number;
  outboxDeleted: number;
  bodiesCleared: number;
}

export async function runRetention(): Promise<RetentionReport> {
  const report: RetentionReport = {
    attemptsDeleted: 0,
    recipientsDeleted: 0,
    outboxDeleted: 0,
    bodiesCleared: 0,
  };

  try {
    // 1. Attempts belonging to recipients that are long-terminal.
    const attemptCutoff = new Date(Date.now() - ATTEMPT_DAYS * 86_400_000);
    report.attemptsDeleted = await purgeOrphanedAttempts(attemptCutoff);

    // 2. Recipients terminal for longer than the retention window.
    const recipientCutoff = new Date(Date.now() - RECIPIENT_DAYS * 86_400_000);
    report.recipientsDeleted = await purgeTerminalRecipients(recipientCutoff);

    // 3. Outbox events already processed.
    const outboxCutoff = new Date(Date.now() - OUTBOX_DAYS * 86_400_000);
    report.outboxDeleted = await purgeOutbox(outboxCutoff);

    // 4. Clear message bodies from fully-terminal schedules; keep the audit row.
    report.bodiesCleared = await clearTerminalBodies();

    logger.info(report, "Retention sweep complete");
  } catch (error) {
    logger.error({ err: error }, "Retention sweep failed");
  }

  return report;
}

async function purgeOrphanedAttempts(cutoff: Date): Promise<number> {
  const doomed = await db
    .select({ id: deliveryAttempts.id })
    .from(deliveryAttempts)
    .where(sql`${deliveryAttempts.createdAt} < ${cutoff}`)
    .limit(BATCH);

  if (doomed.length === 0) return 0;

  const deleted = await db
    .delete(deliveryAttempts)
    .where(
      sql`${deliveryAttempts.id} in (${sql.join(
        doomed.map((d) => sql`${d.id}`),
        sql`, `,
      )})`,
    )
    .returning({ id: deliveryAttempts.id });

  return deleted.length;
}

async function purgeTerminalRecipients(cutoff: Date): Promise<number> {
  const doomed = await db
    .select({ id: recipients.id })
    .from(recipients)
    .where(
      sql`${recipients.updatedAt} < ${cutoff} and ${recipients.status} in ('sent','failed','cancelled')`,
    )
    .limit(BATCH);

  if (doomed.length === 0) return 0;

  // Attempts cascade with the recipient via FK.
  const deleted = await db
    .delete(recipients)
    .where(
      sql`${recipients.id} in (${sql.join(
        doomed.map((d) => sql`${d.id}`),
        sql`, `,
      )})`,
    )
    .returning({ id: recipients.id });

  return deleted.length;
}

async function purgeOutbox(cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(outboxEvents)
    .where(
      sql`${outboxEvents.updatedAt} < ${cutoff} and ${outboxEvents.status} in ('completed','failed')`,
    )
    .returning({ id: outboxEvents.id });

  return deleted.length;
}

/**
 * Strip message bodies once a schedule has no active recipients.
 *
 * Scheduling metadata (subject, counts, timestamps) is retained for audit, but
 * the body may contain confidential content and is no longer needed.
 */
async function clearTerminalBodies(): Promise<number> {
  const cleared = await db
    .update(schedules)
    .set({ body: "", updatedAt: new Date() })
    .where(
      sql`${schedules.body} <> '' and not exists (
        select 1 from ${recipients}
        where ${recipients.scheduleId} = ${schedules.id}
          and ${recipients.status} in ('scheduled','queued','sending')
      )`,
    )
    .returning({ id: schedules.id });

  return cleared.length;
}
