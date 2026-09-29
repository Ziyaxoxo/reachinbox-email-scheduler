import { getSlackConnection } from "./oauth.js";
import { DependencyError } from "../../domain/errors.js";
import { logger } from "../../observability/logger.js";
import { metrics } from "../../observability/metrics.js";

export async function sendSlackNotification(
  ownerId: string,
  message: string,
): Promise<boolean> {
  const connection = await getSlackConnection(ownerId);

  if (!connection) {
    logger.debug({ ownerId }, "No Slack connection available, skipping notification");
    return false;
  }

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: connection.destinationRef,
        text: message,
        unfurl_links: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
    };

    if (!data.ok) {
      throw new DependencyError(`Slack API error: ${data.error ?? "unknown"}`);
    }

    metrics.slackNotifications.inc({ status: "success" });
    logger.info({ ownerId }, "Slack notification sent");
    return true;
  } catch (error) {
    metrics.slackNotifications.inc({ status: "failed" });
    logger.error({ err: error, ownerId }, "Slack notification failed");
    // Rethrow so the outbox dispatcher records the failure and retries. The
    // caller is the outbox worker, which isolates this from email delivery.
    throw error;
  }
}

/**
 * Outbox-dispatched rate-limit notification.
 *
 * Throws on failure so the durable event is retried independently of email
 * delivery, per BE-SLACK-004.
 */
export async function sendSlackRateLimitEvent(
  ownerId: string,
  senderEmail: string,
  hourlyLimit: number,
): Promise<void> {
  const message = [
    ":warning: *Rate limit reached*",
    "",
    `Sender: \`${senderEmail}\``,
    `Hourly limit: *${hourlyLimit}*`,
    "",
    "Remaining recipients were rescheduled to the next available window.",
  ].join("\n");

  await sendSlackNotification(ownerId, message);
}
