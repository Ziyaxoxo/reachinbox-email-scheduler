CREATE TYPE "public"."outbox_event_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outbox_event_type" AS ENUM('email.indexed', 'slack.rate_limit', 'slack.notification');--> statement-breakpoint
CREATE TYPE "public"."recipient_status" AS ENUM('scheduled', 'queued', 'sending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('scheduled', 'queued', 'sending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sender_status" AS ENUM('active', 'paused', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."slack_connection_status" AS ENUM('connected', 'disconnected', 'revoked');--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"provider_id" varchar(255),
	"sent_at" timestamp with time zone,
	"failure_code" varchar(100),
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "outbox_event_type" NOT NULL,
	"aggregate_id" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_event_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_windows" (
	"sender_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"reserved_count" integer DEFAULT 0 NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"normalized_email" varchar(255) NOT NULL,
	"sequence_no" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" "recipient_status" DEFAULT 'scheduled' NOT NULL,
	"claimed_by" varchar(255),
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"subject" varchar(500) NOT NULL,
	"body" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"delay_ms" integer DEFAULT 0 NOT NULL,
	"hourly_limit" integer DEFAULT 100 NOT NULL,
	"status" "schedule_status" DEFAULT 'scheduled' NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"transport_ref" varchar(255) NOT NULL,
	"status" "sender_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"destination_ref" varchar(255) NOT NULL,
	"encrypted_secret_ref" text NOT NULL,
	"status" "slack_connection_status" DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_subject" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"avatar" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_windows" ADD CONSTRAINT "rate_windows_sender_id_senders_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."senders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "senders" ADD CONSTRAINT "senders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_attempts_recipient_idx" ON "delivery_attempts" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "outbox_events_status_idx" ON "outbox_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outbox_events_type_idx" ON "outbox_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events" USING btree ("aggregate_id");--> statement-breakpoint
CREATE INDEX "rate_windows_sender_idx" ON "rate_windows" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "recipients_schedule_idx" ON "recipients" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "recipients_status_idx" ON "recipients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recipients_scheduled_at_idx" ON "recipients" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "recipients_email_idx" ON "recipients" USING btree ("normalized_email");--> statement-breakpoint
CREATE INDEX "schedules_owner_idx" ON "schedules" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "schedules_status_idx" ON "schedules" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_idempotency_idx" ON "schedules" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "schedules_start_at_idx" ON "schedules" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "senders_owner_idx" ON "senders" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "senders_email_idx" ON "senders" USING btree ("email");--> statement-breakpoint
CREATE INDEX "slack_connections_owner_idx" ON "slack_connections" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_provider_subject_idx" ON "users" USING btree ("provider_subject");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");