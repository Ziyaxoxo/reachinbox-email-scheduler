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
  // "ethereal" in every real environment; "stub" only for load/failure runs.
  SMTP_TRANSPORT: z.enum(["ethereal", "stub"]).default("ethereal"),

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

  WORKER_CONCURRENCY: z.string().transform(Number).default("5"),

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
