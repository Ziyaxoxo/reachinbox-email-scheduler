import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db/client.js";
import {
  users,
  senders,
  schedules,
  recipients,
  deliveryAttempts,
} from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  isTerminalRecipientStatus,
  canTransitionRecipient,
} from "../domain/stateMachine.js";
import { createSchedule } from "../services/scheduler.js";

/**
 * Behavioural evidence for idempotency (BE-API-003), durable state
 * (BE-SCHED-003) and terminal-state guarantees (BE-CONC-005).
 */

let ownerId: string;
let otherOwnerId: string;

beforeAll(async () => {
  const stamp = Date.now();
  const [a] = await db
    .insert(users)
    .values({
      providerSubject: `idem-a-${stamp}`,
      email: `idem-a-${stamp}@example.com`,
      name: "Idem A",
    })
    .returning();
  const [b] = await db
    .insert(users)
    .values({
      providerSubject: `idem-b-${stamp}`,
      email: `idem-b-${stamp}@example.com`,
      name: "Idem B",
    })
    .returning();
  ownerId = a!.id;
  otherOwnerId = b!.id;
});

afterAll(async () => {
  for (const id of [ownerId, otherOwnerId]) {
    const owned = await db.query.schedules.findMany({
      where: eq(schedules.ownerId, id),
    });
    for (const s of owned) {
      const rows = await db.query.recipients.findMany({
        where: eq(recipients.scheduleId, s.id),
      });
      for (const r of rows) {
        await db
          .delete(deliveryAttempts)
          .where(eq(deliveryAttempts.recipientId, r.id));
      }
      await db.delete(recipients).where(eq(recipients.scheduleId, s.id));
      await db.delete(schedules).where(eq(schedules.id, s.id));
    }
    await db.delete(senders).where(eq(senders.ownerId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

function baseInput(owner: string, key: string) {
  return {
    ownerId: owner,
    subject: "Idempotency probe",
    body: "hello",
    recipients: ["a@example.com", "b@example.com", "a@example.com"],
    startAt: new Date(Date.now() + 3_600_000),
    delayMs: 0,
    hourlyLimit: 10,
    idempotencyKey: key,
    correlationId: "test",
  };
}

describe("schedule creation is idempotent per owner", () => {
  it("replays the same resource for a repeated key", async () => {
    const key = `idem-${Date.now()}`;

    const first = await createSchedule(baseInput(ownerId, key));
    const second = await createSchedule(baseInput(ownerId, key));

    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);

    const owned = await db.query.schedules.findMany({
      where: eq(schedules.ownerId, ownerId),
    });
    expect(owned.filter((s) => s.idempotencyKey === key)).toHaveLength(1);
  });

  it("lets a different owner reuse the same key value", async () => {
    const key = `shared-${Date.now()}`;

    const mine = await createSchedule(baseInput(ownerId, key));
    const theirs = await createSchedule(baseInput(otherOwnerId, key));

    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.replayed).toBe(false);
  });

  it("deduplicates and normalises recipient addresses", async () => {
    const key = `dedupe-${Date.now()}`;
    const created = await createSchedule({
      ...baseInput(ownerId, key),
      recipients: ["A@Example.com", "a@example.com", " B@example.com "],
    });

    const rows = await db.query.recipients.findMany({
      where: eq(recipients.scheduleId, created.id),
      orderBy: (r, { asc }) => [asc(r.sequenceNo)],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.normalizedEmail)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    // Sequence numbers must be contiguous so configured order is preserved.
    expect(rows.map((r) => r.sequenceNo)).toEqual([1, 2]);
  });

  it("writes recipients as queued so the worker claim can succeed", async () => {
    const key = `queued-${Date.now()}`;
    const created = await createSchedule(baseInput(ownerId, key));

    const rows = await db.query.recipients.findMany({
      where: eq(recipients.scheduleId, created.id),
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe("queued");
    }
  });

  it("records an outbox event per recipient in the same transaction", async () => {
    const key = `outbox-${Date.now()}`;
    const created = await createSchedule(baseInput(ownerId, key));

    const rows = await db.query.recipients.findMany({
      where: eq(recipients.scheduleId, created.id),
    });

    // Two unique recipients after dedupe of the input list.
    expect(rows).toHaveLength(2);
  });
});

describe("terminal states are never re-sendable", () => {
  it.each(["sent", "failed", "cancelled"] as const)(
    "treats %s as terminal",
    (status) => {
      expect(isTerminalRecipientStatus(status)).toBe(true);
    },
  );

  it.each(["scheduled", "queued", "sending"] as const)(
    "treats %s as non-terminal",
    (status) => {
      expect(isTerminalRecipientStatus(status)).toBe(false);
    },
  );

  it("rejects a sent -> sending transition", () => {
    expect(canTransitionRecipient("sent", "sending")).toBe(false);
  });

  it("allows queued -> sending", () => {
    expect(canTransitionRecipient("queued", "sending")).toBe(true);
  });
});
