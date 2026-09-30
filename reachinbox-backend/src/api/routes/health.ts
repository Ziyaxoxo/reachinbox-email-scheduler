import { Router } from "express";
import { pool } from "../../db/client.js";
import { env } from "../../config/env.js";
import { getMode } from "../../domain/mode.js";

export const healthRouter = Router();

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * The role this process actually took, for confirming a deploy.
 *
 * Exists because the container healthcheck structurally cannot check this. A
 * worker has no HTTP listener, so the only evidence that a worker is healthy is
 * that it is not answering — which means no probe can both confirm worker mode
 * and avoid failing on a correctly-running worker. The Dockerfile probe is
 * env-based for exactly that reason and cannot tell whether `resolveMode()`
 * agreed with it.
 *
 * So this is the post-deploy check, and it has to be read as a pair:
 *
 *   - on the API service, `modeVia` should be `default`
 *   - on the worker, the startup log should show `modeVia: "env"`
 *
 * A worker answering this route at all means it started in API mode and is
 * consuming nothing, which is the failure worth catching. See `/health/worker`
 * for that case, and note that a 404 from *this* endpoint means the build
 * predates the route, not that anything is wrong.
 *
 * `workerModeRequested` is reported separately from `isWorker` so the
 * disagreement case is legible: an env var that was set but did not win is
 * exactly the situation that is otherwise invisible.
 */
healthRouter.get("/mode", (_req, res) => {
  const { isWorker, servesHttp, via } = getMode();
  res.json({
    // Naming all three, because the pair is what matters and any single
    // boolean misleads on hybrid: this route responding at all already proves
    // the process serves HTTP.
    mode: isWorker ? (servesHttp ? "hybrid" : "worker") : "api",
    isWorker,
    servesHttp,
    modeVia: via,
    workerModeRequested: env.WORKER_MODE !== "",
    embeddedWorkerRequested: env.EMBEDDED_WORKER !== "",
    pid: process.pid,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Liveness for a process running in worker mode.
 *
 * A worker registers no HTTP listener, so this only ever answers on a worker
 * that was started in API mode by mistake — which is exactly the failure this
 * exists to catch.
 *
 * 404 here means the process is not serving HTTP, i.e. it really is a worker.
 *
 * This is a post-deploy check, not a container probe, and must never be wired
 * into the Dockerfile HEALTHCHECK. A worker cannot answer it, so probing it
 * fails every healthy worker; and on an API replica it returns 404, which
 * `curl -f` treats as a failure anyway. The container probe is env-based for
 * that reason, and cannot verify the resolved mode on its own. Confirm the mode
 * with `GET /health/mode` on the API service, or the `modeVia` field in the
 * worker's startup log.
 */
healthRouter.get("/worker", (_req, res) => {
  res.status(404).json({
    status: "not_an_api",
    message: "This process is serving HTTP, so it is not running as a worker.",
    timestamp: new Date().toISOString(),
  });
});

/**
 * How the mail transport is configured, redacted.
 *
 * Exists because a misconfigured transport produces the worst kind of failure:
 * a healthy service that reports no error anywhere, a dashboard full of normal
 * rows, and `failed` recipients whose only explanation is one log line. The two
 * causes have opposite fixes and differ by a single digit in the SMTP reply —
 *
 *   - `userConfigured: false` means the env vars never arrived; the fix is on
 *     the platform, not the credentials.
 *   - `userConfigured: true` with `verified: false` means they arrived and the
 *     provider refused them; the credentials themselves are wrong.
 *
 * Credential values are never included, so this is safe to serve without auth.
 * `verified` is null until the startup probe has completed, which is reported
 * as unknown rather than guessed either way.
 */
healthRouter.get("/smtp", async (_req, res) => {
  const { getSmtpTransport } = await import("../../services/smtp/transportFactory.js");
  res.json(getSmtpTransport().describe());
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
