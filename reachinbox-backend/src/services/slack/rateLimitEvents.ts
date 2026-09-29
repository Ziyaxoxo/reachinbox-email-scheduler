import { db } from "../../db/client.js";
import { rateWindows } from "../../db/schema.js";
import { and, eq } from "drizzle-orm";
import { enqueueOutboxEvent } from "../../queue/outboxPublisher.js";
import { logger } from "../../observability/logger.js";
import { metrics } from "../../observability/metrics.js";

/**
 * Record a durable rate-limit threshold event.
 *
 * Dedupe is on (sender, window): the rate window row is claimed with a
 * conditional UPDATE, so only the first worker to observe a full window for a
 * given sender/hour emits an event. Sustained saturation therefore notifies once
 * per window instead of once per blocked recipient.
 */
export async function recordRateLimitEvent(input: {
  ownerId: string;
  senderId: string;
  senderEmail: string;
  hourlyLimit: number;
  windowStart: Date;
}): Promise<void> {
  const { outboxEvents } = await import("../../db/schema.js");

  try {
    // Claim the window. `notifiedAt IS NULL` makes this atomic: a second
    // concurrent worker matches zero rows and skips.
    const claimed = await db
      .update(rateWindows)
      .set({ notifiedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(rateWindows.senderId, input.senderId),
          eq(rateWindows.windowStart, input.windowStart),
        ),
      )
      .returning();

    // No row means either the window is untracked or it was already announced.
    if (claimed.length === 0) {
      const existing = await db.query.rateWindows.findFirst({
        where: and(
          eq(rateWindows.senderId, input.senderId),
          eq(rateWindows.windowStart, input.windowStart),
        ),
      });

      if (existing?.notifiedAt) {
        metrics.slackDedupeSkips.inc();
        logger.debug(
          { senderId: input.senderId, windowStart: input.windowStart },
          "Rate-limit already notified for window, skipping duplicate",
        );
        return;
      }

      await db.insert(rateWindows).values({
        senderId: input.senderId,
        windowStart: input.windowStart,
        reservedCount: input.hourlyLimit,
        notifiedAt: new Date(),
      });
    }

    const [event] = await db
      .insert(outboxEvents)
      .values({
        type: "slack.rate_limit",
        aggregateId: `${input.senderId}:${input.windowStart.toISOString()}`,
        payload: {
          ownerId: input.ownerId,
          senderId: input.senderId,
          senderEmail: input.senderEmail,
          hourlyLimit: input.hourlyLimit,
          windowStart: input.windowStart.toISOString(),
        },
        status: "pending",
      })
      .returning({ id: outboxEvents.id });

    if (event) await enqueueOutboxEvent([event.id]);
  } catch (error) {
    // Notification is best-effort and must never fail the email path.
    logger.error({ err: error, senderId: input.senderId }, "Failed to record rate-limit event");
  }
}
