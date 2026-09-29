DROP INDEX "slack_connections_owner_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "slack_connections_owner_idx" ON "slack_connections" USING btree ("owner_id");