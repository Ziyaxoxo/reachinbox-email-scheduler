import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { slackConnections } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../../observability/logger.js";
import { redis } from "../rateLimiter.js";
import { ValidationError } from "../../domain/errors.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  return scryptSync(env.ENCRYPTION_KEY, "reachinbox-salt", KEY_LENGTH);
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(ciphertext: string): string {
  const data = Buffer.from(ciphertext, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

const SLACK_OAUTH_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_CONVERSATIONS_URL = "https://slack.com/api/conversations.list";

const STATE_TTL_SECONDS = 600;
const STATE_KEY_PREFIX = "slack:oauth:state:";

export interface SlackConnectionState {
  token: string;
  destinationRef: string;
  workspaceId: string;
}

export async function initiateSlackOAuth(ownerId: string): Promise<{ url: string; state: string }> {
  const state = randomBytes(16).toString("hex");

  // Bind the random state to the authenticated owner so the callback can
  // identify who authorised, and so forged/replayed callbacks are rejected.
  await redis.set(`${STATE_KEY_PREFIX}${state}`, ownerId, "EX", STATE_TTL_SECONDS);

  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: "chat:write,channels:read",
    state,
    redirect_uri: env.SLACK_CALLBACK_URL,
  });

  logger.info({ ownerId }, "Initiating Slack OAuth");

  return {
    url: `${SLACK_OAUTH_URL}?${params.toString()}`,
    state,
  };
}

export async function handleSlackCallback(code: string, state: string): Promise<void> {
  const stateKey = `${STATE_KEY_PREFIX}${state}`;
  const ownerId = await redis.get(stateKey);

  if (!ownerId) {
    throw new ValidationError("Invalid or expired Slack OAuth state");
  }

  // Single-use state: consume it immediately so replays fail.
  await redis.del(stateKey);

  const response = await fetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: env.SLACK_CALLBACK_URL,
    }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    team?: { id: string; name: string };
  };

  if (!response.ok || !data.ok || !data.access_token || !data.team) {
    throw new Error(`Slack token exchange failed: ${data.error ?? response.status}`);
  }

  const destinationRef = await resolveDefaultChannel(data.access_token);
  const encryptedToken = encrypt(data.access_token);

  await db
    .insert(slackConnections)
    .values({
      ownerId,
      workspaceId: data.team.id,
      destinationRef,
      encryptedSecretRef: encryptedToken,
      status: "connected",
    })
    .onConflictDoUpdate({
      target: slackConnections.ownerId,
      set: {
        workspaceId: data.team.id,
        destinationRef,
        encryptedSecretRef: encryptedToken,
        status: "connected",
        updatedAt: new Date(),
      },
    });

  logger.info(
    { ownerId, workspaceId: data.team.id, destinationRef },
    "Slack connection established",
  );
}

async function resolveDefaultChannel(accessToken: string): Promise<string> {
  try {
    const response = await fetch(
      `${SLACK_CONVERSATIONS_URL}?types=public_channel&exclude_archived=true&limit=200`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    const data = (await response.json()) as {
      ok: boolean;
      channels?: { id: string; name: string }[];
    };

    if (data.ok && data.channels && data.channels.length > 0) {
      const general = data.channels.find((c) => c.name === "general");
      return (general ?? data.channels[0]!).id;
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to resolve default Slack channel");
  }

  return "general";
}

export async function getSlackStatus(ownerId: string): Promise<{
  connected: boolean;
  workspaceId?: string;
  destinationRef?: string;
}> {
  const connection = await db.query.slackConnections.findFirst({
    where: eq(slackConnections.ownerId, ownerId),
  });

  if (!connection || connection.status !== "connected") {
    return { connected: false };
  }

  return {
    connected: true,
    workspaceId: connection.workspaceId,
    destinationRef: connection.destinationRef,
  };
}

export async function disconnectSlack(ownerId: string): Promise<void> {
  await db
    .update(slackConnections)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(eq(slackConnections.ownerId, ownerId));

  logger.info({ ownerId }, "Slack connection disconnected");
}

export async function getSlackConnection(
  ownerId: string,
): Promise<SlackConnectionState | null> {
  const connection = await db.query.slackConnections.findFirst({
    where: eq(slackConnections.ownerId, ownerId),
  });

  if (!connection || connection.status !== "connected") {
    return null;
  }

  try {
    return {
      token: decrypt(connection.encryptedSecretRef),
      destinationRef: connection.destinationRef,
      workspaceId: connection.workspaceId,
    };
  } catch (error) {
    logger.error({ err: error, ownerId }, "Failed to decrypt Slack token");
    return null;
  }
}

export async function getSlackToken(ownerId: string): Promise<string | null> {
  const connection = await getSlackConnection(ownerId);
  return connection?.token ?? null;
}
