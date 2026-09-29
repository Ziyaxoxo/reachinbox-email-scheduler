import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
  varchar,
} from "drizzle-orm/pg-core";

export const scheduleStatusEnum = pgEnum("schedule_status", [
  "scheduled",
  "queued",
  "sending",
  "sent",
  "failed",
  "cancelled",
]);

export const recipientStatusEnum = pgEnum("recipient_status", [
  "scheduled",
  "queued",
  "sending",
  "sent",
  "failed",
  "cancelled",
]);

export const senderStatusEnum = pgEnum("sender_status", ["active", "paused", "suspended"]);

export const slackConnectionStatusEnum = pgEnum("slack_connection_status", [
  "connected",
  "disconnected",
  "revoked",
]);

export const outboxEventStatusEnum = pgEnum("outbox_event_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const outboxEventTypeEnum = pgEnum("outbox_event_type", [
  "email.indexed",
  "slack.rate_limit",
  "slack.notification",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerSubject: varchar("provider_subject", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    avatar: text("avatar"),
    // Nullable: a Google-only account has no password and can never set one
    // without first proving ownership of the address, which the OAuth
    // callback does. Presence of a hash is what marks an account as able to
    // sign in with a password.
    passwordHash: text("password_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerSubjectIdx: uniqueIndex("users_provider_subject_idx").on(t.providerSubject),
    emailIdx: index("users_email_idx").on(t.email),
  }),
);

export const senders = pgTable(
  "senders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    transportRef: varchar("transport_ref", { length: 255 }).notNull(),
    status: senderStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("senders_owner_idx").on(t.ownerId),
    emailIdx: index("senders_email_idx").on(t.email),
  }),
);

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subject: varchar("subject", { length: 500 }).notNull(),
    body: text("body").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    delayMs: integer("delay_ms").notNull().default(0),
    hourlyLimit: integer("hourly_limit").notNull().default(100),
    status: scheduleStatusEnum("status").notNull().default("scheduled"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("schedules_owner_idx").on(t.ownerId),
    statusIdx: index("schedules_status_idx").on(t.status),
    idempotencyIdx: uniqueIndex("schedules_idempotency_idx").on(t.ownerId, t.idempotencyKey),
    startAtIdx: index("schedules_start_at_idx").on(t.startAt),
  }),
);

export const recipients = pgTable(
  "recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    normalizedEmail: varchar("normalized_email", { length: 255 }).notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: recipientStatusEnum("status").notNull().default("scheduled"),
    claimedBy: varchar("claimed_by", { length: 255 }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scheduleIdx: index("recipients_schedule_idx").on(t.scheduleId),
    statusIdx: index("recipients_status_idx").on(t.status),
    scheduledAtIdx: index("recipients_scheduled_at_idx").on(t.scheduledAt),
    emailIdx: index("recipients_email_idx").on(t.normalizedEmail),
  }),
);

export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => recipients.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    providerId: varchar("provider_id", { length: 255 }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failureCode: varchar("failure_code", { length: 100 }),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recipientIdx: index("delivery_attempts_recipient_idx").on(t.recipientId),
  }),
);

export const slackConnections = pgTable(
  "slack_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: varchar("workspace_id", { length: 255 }).notNull(),
    destinationRef: varchar("destination_ref", { length: 255 }).notNull(),
    encryptedSecretRef: text("encrypted_secret_ref").notNull(),
    status: slackConnectionStatusEnum("status").notNull().default("connected"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: uniqueIndex("slack_connections_owner_idx").on(t.ownerId),
  }),
);

export const rateWindows = pgTable(
  "rate_windows",
  {
    senderId: uuid("sender_id")
      .notNull()
      .references(() => senders.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    reservedCount: integer("reserved_count").notNull().default(0),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    senderIdx: index("rate_windows_sender_idx").on(t.senderId),
  }),
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: outboxEventTypeEnum("type").notNull(),
    aggregateId: varchar("aggregate_id", { length: 255 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: outboxEventStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index("outbox_events_status_idx").on(t.status),
    typeIdx: index("outbox_events_type_idx").on(t.type),
    aggregateIdx: index("outbox_events_aggregate_idx").on(t.aggregateId),
  }),
);
