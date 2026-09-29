import promClient from "prom-client";

export const register = new promClient.Registry();

promClient.collectDefaultMetrics({ register });

export const metrics = {
  queueDepth: new promClient.Gauge({
    name: "reachinbox_queue_depth",
    help: "Current depth of BullMQ queues",
    labelNames: ["queue", "status"],
    registers: [register],
  }),

  emailSendDuration: new promClient.Histogram({
    name: "reachinbox_email_send_duration_seconds",
    help: "Duration of email send operations in seconds",
    labelNames: ["sender", "status"],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [register],
  }),

  rateLimitHits: new promClient.Counter({
    name: "reachinbox_rate_limit_hits_total",
    help: "Total number of rate limit hits",
    labelNames: ["sender", "type"],
    registers: [register],
  }),

  rateLimitReservations: new promClient.Counter({
    name: "reachinbox_rate_limit_reservations_total",
    help: "Hourly capacity reservations by outcome",
    labelNames: ["sender", "outcome"],
    registers: [register],
  }),

  emailsSent: new promClient.Counter({
    name: "reachinbox_emails_sent_total",
    help: "Total emails accepted by the transport",
    labelNames: ["sender"],
    registers: [register],
  }),

  emailsFailed: new promClient.Counter({
    name: "reachinbox_emails_failed_total",
    help: "Total terminal email failures",
    labelNames: ["sender", "kind"],
    registers: [register],
  }),

  workerClaimsLost: new promClient.Counter({
    name: "reachinbox_worker_claims_lost_total",
    help: "Recipient claims lost to a concurrent worker",
    registers: [register],
  }),

  reconciliationScans: new promClient.Counter({
    name: "reachinbox_reconciliation_scans_total",
    help: "Reconciliation scans executed",
    registers: [register],
  }),

  reconciliationEnqueued: new promClient.Counter({
    name: "reachinbox_reconciliation_enqueued_total",
    help: "Jobs re-enqueued by reconciliation",
    registers: [register],
  }),

  slackDedupeSkips: new promClient.Counter({
    name: "reachinbox_slack_dedupe_skips_total",
    help: "Duplicate rate-limit notifications suppressed",
    registers: [register],
  }),

  slackNotifications: new promClient.Counter({
    name: "reachinbox_slack_notifications_total",
    help: "Total number of Slack notifications sent",
    labelNames: ["status"],
    registers: [register],
  }),

  outboxEvents: new promClient.Counter({
    name: "reachinbox_outbox_events_total",
    help: "Total number of outbox events processed",
    labelNames: ["type", "status"],
    registers: [register],
  }),

  apiRequests: new promClient.Counter({
    name: "reachinbox_api_requests_total",
    help: "Total number of API requests",
    labelNames: ["method", "route", "status"],
    registers: [register],
  }),

  apiRequestDuration: new promClient.Histogram({
    name: "reachinbox_http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status"],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [register],
  }),
};
