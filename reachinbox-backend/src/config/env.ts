import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.string().transform(Number).default("3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ELASTICSEARCH_URL: z.string().url(),

  SMTP_HOST: z.string().default("smtp.ethereal.email"),
  SMTP_PORT: z.string().transform(Number).default("587"),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),

  // Explicit envelope From, for deployments that must appear to come from a
  // specific address.
  //
  // Empty means "send as the account the credentials belong to", which is the
  // only thing a shared relay mailbox is allowed to do. Override this only when
  // SMTP_USER is a real mailbox the provider owns, because setting a From the
  // provider does not own is how senders get rejected.
  SMTP_FROM: z.string().default(""),

  // "ethereal" locally and on any host that permits outbound SMTP; "brevo" on
  // hosts that block the SMTP ports (free Render web services block 25/465/587);
  // "stub" only for load/failure runs, where nothing is actually delivered.
  SMTP_TRANSPORT: z.enum(["ethereal", "brevo", "stub"]).default("ethereal"),

  // Brevo's HTTP API. Reached over 443, so it works where SMTP cannot, and it
  // authenticates with a single key rather than a user/password pair.
  BREVO_API_KEY: z.string().default(""),
  BREVO_API_URL: z.string().url().default("https://api.brevo.com"),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CALLBACK_URL: z.string().url(),
  FRONTEND_URL: z.string().url().default("http://localhost:3001"),

  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
  SLACK_CALLBACK_URL: z.string().url().default("http://localhost:3000/api/v1/slack/callback"),

  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(1),

  API_RATE_LIMIT_MAX: z.string().transform(Number).default("100"),
  API_RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default("60000"),

  // Much tighter than the general API limit, and separate from it: guessing a
  // password is a small, high-value attack that a 100-per-minute budget on all
  // endpoints would barely slow down.
  AUTH_RATE_LIMIT_MAX: z.string().transform(Number).default("10"),
  AUTH_RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default("900000"),

  WORKER_CONCURRENCY: z.string().transform(Number).default("5"),

  // Selects worker mode. Present on worker services, absent on API services.
  //
  // This exists because mode was previously selected only by the `--worker` CLI
  // flag, which is invisible to anything that does not control the start
  // command: a platform that runs the image's own CMD starts the process in API
  // mode, and the container then serves HTTP instead of consuming queues while
  // still reporting healthy. An env var is set in the service definition, which
  // is one place that is actually visible and reviewable.
  //
  // Any non-empty value means worker, matching the Dockerfile healthcheck, so
  // WORKER_MODE=0 would be wrong: use an unset or empty value for API mode.
  WORKER_MODE: z.string().default(""),

  // Serve HTTP and consume queues from the same process.
  //
  // This exists for deployments that have exactly one long-lived process and no
  // way to run a second one. The motivating case is Render's free tier, which
  // offers no free background worker: the cheapest worker instance is $7/month,
  // so on a no-card budget the API service is the only process there is, and
  // without this it serves HTTP and consumes nothing. Every scheduled email then
  // sits in the queue indefinitely while the dashboard looks healthy.
  //
  // Off by default, and that default is the point. An API replica must not
  // become a sender implicitly, because send concurrency would then scale with
  // replica count: two API pods would send twice as fast as one, which is not a
  // decision anyone made. Opting in per-deployment keeps that impossible by
  // default, and the single-instance case explicit.
  //
  // Same non-empty-value rule as WORKER_MODE, so EMBEDDED_WORKER=0 is wrong.
  // WORKER_MODE wins over this if both are set: a process serving no HTTP cannot
  // also be an API replica.
  EMBEDDED_WORKER: z.string().default(""),

  // BullMQ dashboard (operator-only, never public).
  // Empty means "disabled": the dashboard refuses all access rather than
  // defaulting open, so a missing secret fails closed.
  DASHBOARD_TOKEN: z.string().default(""),
  DASHBOARD_READ_ONLY: z
    .string()
    .transform((v) => v !== "false")
    .default("true"),

  MAX_RECIPIENTS_PER_SCHEDULE: z.string().transform(Number).default("1000"),
  IDEMPOTENCY_KEY_TTL_HOURS: z.string().transform(Number).default("24"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
