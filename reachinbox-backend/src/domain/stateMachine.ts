import type { ScheduleStatus, RecipientStatus } from "./entities.js";

const scheduleTransitions: Record<ScheduleStatus, ScheduleStatus[]> = {
  scheduled: ["queued", "cancelled"],
  // A schedule's status is a derived aggregate over its recipients, so it can
  // legitimately jump straight to a terminal state: a single-recipient campaign
  // may finish before any observer sees `sending`, and a rollup running after a
  // crash between the recipient update and the rollup recomputes `queued` into
  // an already-finished result. Deriving is idempotent, so allowing the jump
  // costs nothing and refusing it would strand the row in `queued` forever.
  queued: ["sending", "scheduled", "failed", "sent"],
  sending: ["sent", "queued", "failed"],
  sent: [],
  failed: [],
  cancelled: [],
};

const recipientTransitions: Record<RecipientStatus, RecipientStatus[]> = {
  scheduled: ["queued", "cancelled"],
  queued: ["sending", "scheduled", "failed"],
  sending: ["sent", "queued", "failed"],
  sent: [],
  failed: [],
  cancelled: [],
};

export function canTransitionSchedule(from: ScheduleStatus, to: ScheduleStatus): boolean {
  return scheduleTransitions[from]?.includes(to) ?? false;
}

export function canTransitionRecipient(from: RecipientStatus, to: RecipientStatus): boolean {
  return recipientTransitions[from]?.includes(to) ?? false;
}

export function isTerminalScheduleStatus(status: ScheduleStatus): boolean {
  return status === "sent" || status === "failed" || status === "cancelled";
}

export function isTerminalRecipientStatus(status: RecipientStatus): boolean {
  return status === "sent" || status === "failed" || status === "cancelled";
}
