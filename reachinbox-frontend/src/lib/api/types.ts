export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string | null;
  /**
   * Whether a password is set on this account. The server never sends the hash
   * itself, just this flag, which is what Settings needs to decide between
   * "set a password" and "change your password".
   */
  hasPassword?: boolean;
}

export interface Schedule {
  id: string;
  ownerId: string;
  subject: string;
  body: string;
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
  status: "scheduled" | "queued" | "sending" | "sent" | "failed" | "cancelled";
  idempotencyKey: string;
  /**
   * Recipient summary, joined by the list endpoint.
   *
   * Declared explicitly so the client contract cannot drift from the API: the
   * Scheduled view renders a real recipient address, never a schedule id.
   * `recipientCount` disambiguates a single-recipient campaign from one of
   * many, since a campaign can address up to 1000 recipients.
   */
  recipientCount: number;
  firstRecipientEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Recipient {
  id: string;
  scheduleId: string;
  normalizedEmail: string;
  sequenceNo: number;
  scheduledAt: string;
  status: "scheduled" | "queued" | "sending" | "sent" | "failed" | "cancelled";
  claimedBy?: string | null;
  claimExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Recipient-level delivery record from GET /api/v1/emails/sent.
 *
 * Declared explicitly so the client contract cannot drift from the API: the Sent
 * view renders a real recipient address and a real delivery timestamp.
 */
export interface SentEmailRecord {
  id: string;
  scheduleId: string;
  normalizedEmail: string;
  sequenceNo: number;
  scheduledAt: string;
  status: "scheduled" | "queued" | "sending" | "sent" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  subject: string;
  body: string;
  startAt: string;
  ownerId: string;
  senderEmail: string | null;
  attempt: number | null;
  providerId: string | null;
  sentAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface DeliveryAttempt {
  id: string;
  recipientId: string;
  attempt: number;
  providerId?: string | null;
  sentAt?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  createdAt: string;
}

export interface SlackConnection {
  id: string;
  ownerId: string;
  workspaceId: string;
  destinationRef: string;
  status: "connected" | "disconnected" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, string>;
    correlationId?: string;
  };
}

export interface CreateScheduleRequest {
  subject: string;
  body: string;
  recipients: string[];
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
  idempotencyKey?: string;
}

export interface CreateScheduleResponse {
  id: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
  /** True when the request replayed an existing schedule for the same key. */
  replayed?: boolean;
}

export interface SlackStatusResponse {
  connected: boolean;
  workspaceId?: string;
  destinationRef?: string;
}
