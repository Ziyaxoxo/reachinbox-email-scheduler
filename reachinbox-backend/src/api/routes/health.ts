import { Router } from "express";
import { pool } from "../../db/client.js";
import { env } from "../../config/env.js";

export const healthRouter = Router();

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * Liveness for a process running in worker mode.
 *
 * A worker registers no HTTP listener, so this only ever answers on a worker
 * that was started in API mode by mistake — which is exactly the failure this
 * exists to catch. The previous check was `process.exit(0)` gated on the
 * `WORKER_MODE` env var, which reported healthy for a process that was serving
 * HTTP and consuming nothing.
 *
 * 404 here means the process is not serving HTTP, i.e. it really is a worker.
 */
healthRouter.get("/worker", (_req, res) => {
  res.status(404).json({
    status: "not_an_api",
    message: "This process is serving HTTP, so it is not running as a worker.",
    timestamp: new Date().toISOString(),
  });
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
