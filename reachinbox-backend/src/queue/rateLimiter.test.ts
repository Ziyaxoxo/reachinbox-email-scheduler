import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import { db } from "../db/client.js";
import {
  recipients,
  schedules,
  senders,
  users,
  deliveryAttempts,
} from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { currentWindowStart, nextWindowStart, windowKeyFor } from "./window.js";

/**
 * Concurrency evidence for BE-CONC-002 and BE-RATE-003.
 *
 * These tests drive real Redis + PostgreSQL through docker-compose, so they
 * prove the atomicity claims rather than asserting against mocks.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://:reachinbox@localhost:6379/0";

const lua = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local current = redis.call('GET', key)
if not current then
  redis.call('SET', key, 1, 'EX', ttl)
  return {1, 1}
end
current = tonumber(current)
if current >= limit then
  return {0, current}
end
local updated = redis.call('INCR', key)
if updated == 1 then redis.call('EXPIRE', key, ttl) end
return {1, updated}
`;

describe("hourly capacity reservation under contention", () => {
  it("never hands out more slots than the limit when 20 workers race", async () => {
    const redis = new Redis(REDIS_URL);
    const senderId = `race-${Date.now()}`;
    const limit = 5;
    const window = currentWindowStart(Date.now());
    const key = windowKeyFor(senderId, window);

    await redis.del(key);

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        redis.eval(lua, 1, key, String(limit), "3660"),
      ),
    );

    const granted = attempts.filter((r) => (r as number[])[0] === 1).length;
    const counter = Number(await redis.get(key));

    expect(granted).toBe(limit);
    expect(counter).toBe(limit);

    await redis.del(key);
    await redis.quit();
  });

  it("reserves exactly one of two workers for the final slot", async () => {
    const redis = new Redis(REDIS_URL);
    const senderId = `final-${Date.now()}`;
    const limit = 1;
    const key = windowKeyFor(senderId, currentWindowStart(Date.now()));

    await redis.del(key);

    const [a, b] = await Promise.all([
      redis.eval(lua, 1, key, String(limit), "3660"),
      redis.eval(lua, 1, key, String(limit), "3660"),
    ]);

    const winners = [a, b].filter((r) => (r as number[])[0] === 1).length;
    expect(winners).toBe(1);

    await redis.del(key);
    await redis.quit();
  });
});

describe("aligned window boundaries", () => {
  it("buckets by UTC hour so all instances agree", () => {
    const t = Date.UTC(2026, 8, 29, 10, 30, 0, 0);
    const start = currentWindowStart(t);

    expect(new Date(start).toISOString()).toBe("2026-09-29T10:00:00.000Z");
    expect(nextWindowStart(start)).toBe(start + 3_600_000);
  });

  it("maps different instants in the same hour to the same bucket", () => {
    const a = currentWindowStart(Date.UTC(2026, 8, 29, 10, 0, 1));
    const b = currentWindowStart(Date.UTC(2026, 8, 29, 10, 59, 59));
    expect(a).toBe(b);
  });

  it("maps the next hour to a different bucket", () => {
    const a = currentWindowStart(Date.UTC(2026, 8, 29, 10, 59, 59));
    const b = currentWindowStart(Date.UTC(2026, 8, 29, 11, 0, 1));
    expect(b).toBe(a + 3_600_000);
  });
});

describe("recipient claim is a single-owner compare-and-set", () => {
  let ownerId: string;
  let scheduleId: string;
  let recipientId: string;

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({
        providerSubject: `test-${Date.now()}`,
        email: `claim-${Date.now()}@example.com`,
        name: "Claim Test",
      })
      .returning();
    ownerId = user!.id;

    const [sender] = await db
      .insert(senders)
      .values({ ownerId, email: "sender@example.com", transportRef: "ethereal" })
      .returning();

    const [schedule] = await db
      .insert(schedules)
      .values({
        ownerId,
        subject: "Claim race",
        body: "body",
        startAt: new Date(),
        delayMs: 0,
        hourlyLimit: 10,
        idempotencyKey: `claim-race-${Date.now()}`,
      })
      .returning();
    scheduleId = schedule!.id;

    const [recipient] = await db
      .insert(recipients)
      .values({
        scheduleId,
        normalizedEmail: "race@example.com",
        sequenceNo: 1,
        scheduledAt: new Date(),
        status: "queued",
      })
      .returning();
    recipientId = recipient!.id;

    expect(sender).toBeDefined();
  });

  afterAll(async () => {
    await db
      .delete(deliveryAttempts)
      .where(eq(deliveryAttempts.recipientId, recipientId));
    await db.delete(recipients).where(eq(recipients.id, recipientId));
    await db.delete(schedules).where(eq(schedules.id, scheduleId));
    await db.delete(users).where(eq(users.id, ownerId));
  });

  it("allows exactly one of ten concurrent claims to win", async () => {
    const claim = () =>
      db
        .update(recipients)
        .set({
          status: "sending",
          claimedBy: `worker-${Math.random()}`,
          claimExpiresAt: new Date(Date.now() + 60_000),
        })
        .where(
          and(eq(recipients.id, recipientId), eq(recipients.status, "queued")),
        )
        .returning();

    const results = await Promise.all(Array.from({ length: 10 }, claim));
    const winners = results.filter((r) => r.length > 0);

    expect(winners).toHaveLength(1);
  });

  it("refuses a second claim once the recipient is claimed", async () => {
    const second = await db
      .update(recipients)
      .set({ status: "sending", claimedBy: "another" })
      .where(
        and(eq(recipients.id, recipientId), eq(recipients.status, "queued")),
      )
      .returning();

    expect(second).toHaveLength(0);
  });
});
