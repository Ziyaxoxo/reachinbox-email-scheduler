import { createServer } from "./api/server.js";
import { env } from "./config/env.js";
import { logger } from "./observability/logger.js";
import { runMigrations } from "./db/migrate.js";
import { ensureIndex } from "./services/elasticsearch/client.js";
import { reconcilePendingWork } from "./queue/reconciliation.js";
import { runRetention } from "./services/retention.js";
import { setupGracefulShutdown } from "./workers/gracefulShutdown.js";
import { refreshQueueDepthMetrics } from "./observability/queueMetrics.js";

const RECONCILE_INTERVAL_MS = 60_000;
const QUEUE_METRICS_INTERVAL_MS = 15_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Decide which role this process plays.
 *
 * Either signal selects worker mode, and they cannot disagree: an operator
 * setting `WORKER_MODE` on an API service by mistake is a mistake worth
 * honouring loudly rather than quietly ignoring, because the symptom of
 * getting it wrong in the other direction (a worker that silently serves HTTP
 * instead of consuming) is invisible from outside.
 */
function resolveMode(): { isWorker: boolean; via: string } {
  if (process.argv.includes("--worker")) {
    return { isWorker: true, via: "argv" };
  }
  if (env.WORKER_MODE !== "") {
    return { isWorker: true, via: "env" };
  }
  return { isWorker: false, via: "default" };
}

async function main() {
  const { isWorker, via } = resolveMode();

  logger.info(
    { env: env.NODE_ENV, isWorker, modeVia: via },
    "Starting ReachInbox backend",
  );

  // Schema before anything that reads it. Reconciliation, the workers and every
  // request path query tables that this image's migrations create, so applying
  // them first is what keeps a freshly deployed container from serving traffic
  // against a database that is a version behind.
  await runMigrations();

  // Search index is derived state: never block startup on it.
  await ensureIndex();

  setupGracefulShutdown();

  if (isWorker) {
    // Imported here, not at module scope: an API replica must never become a
    // send worker, otherwise effective concurrency silently scales with the
    // number of API pods.
    const [{ emailWorker }, { outboxWorker }] = await Promise.all([
      import("./workers/emailWorker.js"),
      import("./workers/outboxWorker.js"),
    ]);

    logger.info(
      { email: emailWorker.id, outbox: outboxWorker.id, modeVia: via },
      "Worker mode: consuming email-scheduling and outbox-events",
    );

    // Workers do not serve HTTP, so queue depth is sampled on an interval to
    // keep BE-OBS-002 satisfied without a metrics endpoint.
    setInterval(() => {
      void refreshQueueDepthMetrics();
    }, QUEUE_METRICS_INTERVAL_MS);
    void refreshQueueDepthMetrics();

    // Retention is owner-independent maintenance, so it runs with the workers
    // rather than every API replica.
    const retentionTimer = setInterval(() => {
      void runRetention();
    }, RETENTION_INTERVAL_MS);
    retentionTimer.unref?.();

    void runRetention();

    logger.info("Worker ready");
    return;
  }

  // API mode: serve HTTP only.

  logger.info("API mode: serving HTTP");

  // Recover queue state from the authoritative database on boot.
  await reconcilePendingWork();

  const reconcileTimer = setInterval(() => {
    void reconcilePendingWork();
  }, RECONCILE_INTERVAL_MS);

  // The API replica must not double-sweep retention; workers own it.
  reconcileTimer.unref?.();

  const app = createServer();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "API server listening");
  });

  server.on("error", (error) => {
    logger.error({ err: error }, "Server error");
  });
}

main().catch((error) => {
  logger.error({ err: error }, "Fatal error during startup");
  process.exit(1);
});
