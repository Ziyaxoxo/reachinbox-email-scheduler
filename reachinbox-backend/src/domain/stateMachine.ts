import type { ScheduleStatus, RecipientStatus } from "./entities.js";

const scheduleTransitions: Record<ScheduleStatus, ScheduleStatus[]> = {
  scheduled: ["queued", "cancelled"],
  queued: ["sending", "scheduled", "failed"],
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
