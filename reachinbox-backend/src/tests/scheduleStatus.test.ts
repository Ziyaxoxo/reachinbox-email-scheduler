import { describe, it, expect } from "vitest";
import { deriveScheduleStatus } from "../domain/scheduleStatus.js";
import {
  canTransitionSchedule,
  isTerminalScheduleStatus,
} from "../domain/stateMachine.js";

/**
 * A schedule's status is derived from its recipients, so every dashboard state
 * a user can observe has to be reachable from some combination of recipient
 * states. These cases are the whole truth table of that mapping.
 */
describe("deriveScheduleStatus", () => {
  it("returns null when there are no recipients to derive from", () => {
    expect(deriveScheduleStatus({})).toBeNull();
  });

  it("is queued while every recipient is still waiting", () => {
    expect(deriveScheduleStatus({ queued: 10 })).toBe("queued");
    expect(deriveScheduleStatus({ scheduled: 5 })).toBe("queued");
    expect(deriveScheduleStatus({ queued: 3, scheduled: 2 })).toBe("queued");
  });

  it("is sending once a recipient is claimed", () => {
    expect(deriveScheduleStatus({ sending: 1 })).toBe("sending");
    expect(deriveScheduleStatus({ sending: 1, queued: 9 })).toBe("sending");
  });

  it("is sending while a finished campaign still has work outstanding", () => {
    // The state a user spends most of a large campaign looking at: part done,
    // part still going. Reporting `queued` here would hide real progress.
    expect(deriveScheduleStatus({ sent: 40, queued: 60 })).toBe("sending");
    expect(deriveScheduleStatus({ sent: 40, sending: 1, queued: 59 })).toBe(
      "sending",
    );
  });

  it("is sent when every recipient was delivered", () => {
    expect(deriveScheduleStatus({ sent: 1 })).toBe("sent");
    expect(deriveScheduleStatus({ sent: 100 })).toBe("sent");
  });

  it("is sent when a campaign delivered at least once despite failures", () => {
    // Partial failure is a completed campaign with per-row detail, not a
    // failed one: reporting `failed` would hide that mail did go out.
    expect(deriveScheduleStatus({ sent: 8, failed: 2 })).toBe("sent");
    expect(deriveScheduleStatus({ sent: 1, failed: 1, cancelled: 1 })).toBe(
      "sent",
    );
  });

  it("is failed only when nothing at all was delivered", () => {
    expect(deriveScheduleStatus({ failed: 1 })).toBe("failed");
    expect(deriveScheduleStatus({ failed: 5 })).toBe("failed");
    expect(deriveScheduleStatus({ failed: 2, cancelled: 3 })).toBe("failed");
  });

  it("ignores zero-valued and absent states", () => {
    expect(deriveScheduleStatus({ sent: 0, queued: 2 })).toBe("queued");
    expect(deriveScheduleStatus({ sent: 0, failed: 0, queued: 1 })).toBe(
      "queued",
    );
  });

  it("is stable: deriving twice on the same input gives the same answer", () => {
    // Idempotence is what makes it safe for several workers to roll up the same
    // schedule concurrently.
    const counts = { sent: 3, failed: 1 };
    expect(deriveScheduleStatus(counts)).toBe(deriveScheduleStatus(counts));
  });
});

describe("schedule state machine", () => {
  it("allows the normal queued -> sending -> sent path", () => {
    expect(canTransitionSchedule("queued", "sending")).toBe(true);
    expect(canTransitionSchedule("sending", "sent")).toBe(true);
  });

  it("allows a jump from queued straight to a terminal state", () => {
    // Legitimate for a derived aggregate: a single-recipient campaign can
    // finish before any observer sees `sending`, and a rollup repairing a
    // crashed worker's row recomputes `queued` into a finished result.
    expect(canTransitionSchedule("queued", "sent")).toBe(true);
    expect(canTransitionSchedule("queued", "failed")).toBe(true);
  });

  it("never leaves a terminal state", () => {
    for (const terminal of ["sent", "failed", "cancelled"] as const) {
      expect(isTerminalScheduleStatus(terminal)).toBe(true);
      for (const target of ["queued", "sending", "sent", "failed"] as const) {
        expect(canTransitionSchedule(terminal, target)).toBe(false);
      }
    }
  });
});
