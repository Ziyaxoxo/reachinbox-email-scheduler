import { Router } from "express";
import { pool } from "../../db/client.js";
import { env } from "../../config/env.js";

export const healthRouter = Router();

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

healthRouter.get("/ready", async (_req, res) => {
  const checks: Record<string, boolean> = {};

  try {
    await pool.query("SELECT 1");
    checks.database = true;
  } catch {
    checks.database = false;
  }

  try {
    const { default: Redis } = await import("ioredis");
    const redis = new Redis(env.REDIS_URL);
    await redis.ping();
    await redis.quit();
    checks.redis = true;
  } catch {
    checks.redis = false;
  }

  try {
    const { Client } = await import("@elastic/elasticsearch");
    const es = new Client({ node: env.ELASTICSEARCH_URL });
    await es.ping();
    checks.elasticsearch = true;
  } catch {
    checks.elasticsearch = false;
  }

  const allHealthy = Object.values(checks).every(Boolean);

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "ready" : "not_ready",
    checks,
    timestamp: new Date().toISOString(),
  });
});
