import type { RecipientStatus, ScheduleStatus } from "./entities.js";

/**
 * How many of a schedule's recipients currently sit in each state.
 */
export type RecipientStatusCounts = Partial<Record<RecipientStatus, number>>;

/**
 * A schedule's status is a *derived aggregate* over its recipients, never an
 * independently tracked fact. The recipient rows are the audit record; this
 * function is the only place that decides what the parent row should say.
 *
 * Deriving it (rather than letting each worker write the parent as it goes)
 * matters because several recipients are in flight at once and a campaign can
 * finish on whichever worker happens to be last. Reading the recipients and
 * recomputing is idempotent and order-independent: any worker that observes a
 * recipient state change can call it and converge on the same answer.
 */
export function deriveScheduleStatus(
  counts: RecipientStatusCounts,
): ScheduleStatus | null {
  const at = (status: RecipientStatus) => counts[status] ?? 0;

  const sent = at("sent");
  const failed = at("failed");
  const cancelled = at("cancelled");
  const sending = at("sending");
  // `scheduled` is the pre-queue state; a recipient still in it is pending.
  const pending = at("queued") + at("scheduled");

  const total = sent + failed + cancelled + sending + pending;

  // Nothing to say. A schedule always has at least one recipient, so this only
  // happens for a partially-created row, and leaving the status untouched is
  // safer than inventing one.
  if (total === 0) return null;

  // Every recipient has finished. A campaign that delivered at least one
  // message is a completed campaign with partial failures visible per row; one
  // where nothing was delivered failed as a whole.
  if (sent + failed + cancelled === total) {
    return sent > 0 ? "sent" : "failed";
  }

  // Work has started but not finished: either a recipient is claimed right now,
  // or some already finished while others are still waiting.
  if (sending > 0 || sent > 0 || failed > 0) return "sending";

  // Every recipient is still waiting for its time.
  return "queued";
}
