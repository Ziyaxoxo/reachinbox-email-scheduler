import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
});

const TTL_SECONDS = WINDOW_SECONDS + 60;

import {
  WINDOW_SECONDS,
  currentWindowStart,
  nextWindowStart,
  windowKeyFor as windowKey,
} from "../queue/window.js";

/**
 * Atomically reserve one slot in the sender's current hourly window.
 *
 * Lua keeps the read-compare-increment atomic across instances. Returns the
 * current reservation count so the caller can distinguish "full" from "reserved
 * the last slot", and reports the next aligned window start when full.
 */
const RESERVE_HOURLY_CAPACITY_SCRIPT = `
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
if updated == 1 then
  redis.call('EXPIRE', key, ttl)
end

return {1, updated}
`;

/**
 * Reserve the next eligible send slot for a sender.
 *
 * Semantics: the key holds the earliest time a send may occur. A caller that
 * wins the reservation advances it; a caller that loses must NOT touch it.
 * Advancing on a failed reservation is a feedback loop — each deferral pushes
 * the timestamp further out, so a burst of concurrent workers starves the queue
 * for a growing number of intervals instead of draining at minDelay spacing.
 *
 * Returns {allowed, previousEligibleAt, nextEligibleAt}.
 */
const DELAY_KEY_SCRIPT = `
local key = KEYS[1]
local minDelay = tonumber(ARGV[1])
local now = tonumber(ARGV[2])

local current = redis.call('GET', key)

if not current then
  local nextAt = now + minDelay
  redis.call('SET', key, nextAt, 'PX', math.max(minDelay, 1000))
  return {1, now, nextAt}
end

current = tonumber(current)

if current > now then
  -- Someone already holds the next slot. Report the wait and leave the key alone.
  return {0, current, current}
end

local nextAt = now + minDelay
redis.call('SET', key, nextAt, 'PX', math.max(minDelay, 1000))
return {1, current, nextAt}
`;

export interface HourlyReservationResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  /** Start of the window that was evaluated. */
  windowStart: Date;
  /** Start of the next aligned window, valid when `allowed` is false. */
  nextWindowStart: Date;
}

export interface DelayReservationResult {
  /** True when this caller holds the next slot and may send now. */
  allowed: boolean;
  /** When the next slot becomes available. */
  nextEligibleAt: number;
  /** How long this caller must wait; 0 when allowed. */
  waitMs: number;
}

/**
 * Read the next eligible send time without reserving it.
 *
 * Used to skip the hourly reservation entirely when a sender is still inside
 * its minimum-delay window. Reserving hourly capacity for work that cannot send
 * yet inflates the window counter and can push unrelated recipients past the
 * limit into the next hour for no reason.
 */
export async function peekSenderDelay(
  senderId: string,
): Promise<{ eligible: boolean; waitMs: number }> {
  const key = `rate_limit:${senderId}:delay`;

  try {
    const current = await redis.get(key);
    if (!current) return { eligible: true, waitMs: 0 };

    const nextEligibleAt = Number(current);
    const waitMs = Math.max(0, nextEligibleAt - Date.now());

    return { eligible: waitMs === 0, waitMs };
  } catch (error) {
    // Fail open: let the caller proceed to the authoritative hourly check.
    logger.error({ err: error, senderId }, "Failed to peek sender delay");
    return { eligible: true, waitMs: 0 };
  }
}

export async function reserveHourlyCapacity(
  senderId: string,
  hourlyLimit: number,
): Promise<HourlyReservationResult> {
  const now = Date.now();
  const windowStart = currentWindowStart(now);
  const key = windowKey(senderId, windowStart);

  try {
    const result = (await redis.eval(
      RESERVE_HOURLY_CAPACITY_SCRIPT,
      1,
      key,
      String(hourlyLimit),
      String(TTL_SECONDS),
    )) as [number, number];

    const allowed = result[0] === 1;
    const currentCount = result[1]!;

    metrics.rateLimitReservations.inc({
      sender: senderId,
      outcome: allowed ? "reserved" : "exhausted",
    });

    if (!allowed) {
      metrics.rateLimitHits.inc({ sender: senderId, type: "hourly" });
    }

    return {
      allowed,
      currentCount,
      limit: hourlyLimit,
      windowStart: new Date(windowStart),
      nextWindowStart: new Date(nextWindowStart(windowStart)),
    };
  } catch (error) {
    logger.error({ err: error, senderId }, "Failed to reserve hourly capacity");
    // Fail open: DB state stays authoritative and reconciliation will re-run
    // anything that did not send. Dropping the send would be worse than
    // briefly over-sending after a Redis outage.
    return {
      allowed: true,
      currentCount: 0,
      limit: hourlyLimit,
      windowStart: new Date(windowStart),
      nextWindowStart: new Date(nextWindowStart(windowStart)),
    };
  }
}

export async function advanceSenderDelay(
  senderId: string,
  minDelayMs: number,
): Promise<DelayReservationResult> {
  const now = Date.now();
  const key = `rate_limit:${senderId}:delay`;

  try {
    const result = (await redis.eval(
      DELAY_KEY_SCRIPT,
      1,
      key,
      String(minDelayMs),
      String(now),
    )) as [number, number, number];

    const allowed = result[0] === 1;
    const nextEligibleAt = result[2]!;

    return {
      allowed,
      nextEligibleAt,
      waitMs: allowed ? 0 : Math.max(0, nextEligibleAt - now),
    };
  } catch (error) {
    // Fail open on a Redis outage rather than stalling the queue; the hourly
    // limiter and DB state still bound the blast radius.
    logger.error({ err: error, senderId }, "Failed to reserve sender delay slot");
    return { allowed: true, nextEligibleAt: now + minDelayMs, waitMs: 0 };
  }
}

/**
 * Return a reserved slot after a pre-send failure.
 *
 * Guarded so the counter can never go negative: a duplicate release (retry
 * racing the original failure path) is a no-op rather than creating free
 * capacity that lets the sender exceed its configured limit.
 */
export async function releaseHourlyCapacity(
  senderId: string,
  windowStart?: Date,
): Promise<void> {
  const startMs =
    windowStart instanceof Date ? windowStart.getTime() : windowStart ?? currentWindowStart(Date.now());
  const key = windowKey(senderId, startMs);

  try {
    const current = await redis.get(key);
    if (!current) return;

    const next = Number(current) - 1;
    if (next > 0) {
      await redis.set(key, String(next), "KEEPTTL");
    } else {
      await redis.del(key);
    }
  } catch (error) {
    logger.error({ err: error, senderId }, "Failed to release hourly capacity");
  }
}

export async function getHourlyCount(senderId: string): Promise<number> {
  const key = windowKey(senderId, currentWindowStart(Date.now()));
  try {
    const count = await redis.get(key);
    return count ? parseInt(count, 10) : 0;
  } catch {
    return 0;
  }
}

export { redis, currentWindowStart, nextWindowStart };
