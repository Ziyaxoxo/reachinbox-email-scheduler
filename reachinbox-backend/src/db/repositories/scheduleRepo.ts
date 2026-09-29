import { db } from "../client.js";
import { schedules, recipients } from "../schema.js";
import { eq, and, desc, sql, type SQL } from "drizzle-orm";
import { deriveScheduleStatus } from "../../domain/scheduleStatus.js";
import { canTransitionSchedule } from "../../domain/stateMachine.js";

export async function findScheduleById(id: string) {
  return db.query.schedules.findFirst({
    where: eq(schedules.id, id),
  });
}

export async function findSchedulesByOwner(
  ownerId: string,
  options: { page: number; limit: number; status?: string; search?: string },
) {
  const { page, limit, status, search } = options;
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [eq(schedules.ownerId, ownerId)];
  if (status) conditions.push(eq(schedules.status, status as never));
  if (search) {
    conditions.push(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (schedules.subject as any).ilike(`%${search}%`),
    );
  }

  return db.query.schedules.findMany({
    where: and(...conditions),
    orderBy: [desc(schedules.createdAt)],
    limit,
    offset,
  });
}

export async function updateScheduleStatus(id: string, status: string) {
  await db
    .update(schedules)
    .set({ status: status as never, updatedAt: new Date() })
    .where(eq(schedules.id, id));
}

/**
 * Recompute a schedule's status from its recipients and persist it.
 *
 * This is the only writer of `schedules.status` after creation. It is called
 * from the worker whenever a recipient changes state, and from reconciliation
 * for schedules whose recipients are already terminal. Being derived rather than
 * incrementally tracked is what makes it safe to call repeatedly and from
 * several workers at once: each call reads the current truth and converges.
 *
 * Returns the status actually written, or null when nothing changed — a
 * schedule already `cancelled` is left alone, since cancellation is a user
 * decision and not a function of recipient outcomes.
 */
export async function refreshScheduleStatus(
  scheduleId: string,
): Promise<string | null> {
  const rows = await db
    .select({ status: recipients.status, n: sql<number>`count(*)::int` })
    .from(recipients)
    .where(eq(recipients.scheduleId, scheduleId))
    .groupBy(recipients.status);

  const derived = deriveScheduleStatus(
    Object.fromEntries(rows.map((r) => [r.status, r.n])),
  );
  if (!derived) return null;

  const current = await db.query.schedules.findFirst({
    where: eq(schedules.id, scheduleId),
    columns: { status: true },
  });
  if (!current) return null;
  if (current.status === derived) return null;

  // Never resurrect a schedule the user cancelled, and never move one out of a
  // terminal state: a late-arriving worker must not rewrite a finished result.
  if (current.status === "cancelled") return null;
  if (!canTransitionSchedule(current.status, derived)) return null;

  await updateScheduleStatus(scheduleId, derived);
  return derived;
}
