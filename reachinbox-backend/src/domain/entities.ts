export type ScheduleStatus = "scheduled" | "queued" | "sending" | "sent" | "failed" | "cancelled";
export type RecipientStatus = "scheduled" | "queued" | "sending" | "sent" | "failed" | "cancelled";
export type SenderStatus = "active" | "paused" | "suspended";
export type SlackConnectionStatus = "connected" | "disconnected" | "revoked";
export type OutboxEventStatus = "pending" | "processing" | "completed" | "failed";
export type OutboxEventType = "email.indexed" | "slack.rate_limit" | "slack.notification";

export interface User {
  id: string;
  providerSubject: string;
  email: string;
  name: string;
  avatar: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Sender {
  id: string;
  ownerId: string;
  email: string;
  transportRef: string;
  status: SenderStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Schedule {
  id: string;
  ownerId: string;
  subject: string;
  body: string;
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
  status: ScheduleStatus;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Recipient {
  id: string;
  scheduleId: string;
  normalizedEmail: string;
  sequenceNo: number;
  scheduledAt: Date;
  status: RecipientStatus;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryAttempt {
  id: string;
  recipientId: string;
  attempt: number;
  providerId: string | null;
  sentAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
}

export interface SlackConnection {
  id: string;
  ownerId: string;
  workspaceId: string;
  destinationRef: string;
  encryptedSecretRef: string;
  status: SlackConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface RateWindow {
  senderId: string;
  windowStart: Date;
  reservedCount: number;
  notifiedAt: Date | null;
}

export interface OutboxEvent {
  id: string;
  type: OutboxEventType;
  aggregateId: string;
  payload: unknown;
  status: OutboxEventStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}
