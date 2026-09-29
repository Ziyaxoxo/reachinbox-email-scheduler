import { createServer } from "./api/server.js";
import { env } from "./config/env.js";
import { logger } from "./observability/logger.js";
import { ensureIndex } from "./services/elasticsearch/client.js";
import { reconcilePendingWork } from "./queue/reconciliation.js";
import { runRetention } from "./services/retention.js";
import { setupGracefulShutdown } from "./workers/gracefulShutdown.js";
import { refreshQueueDepthMetrics } from "./observability/queueMetrics.js";

const RECONCILE_INTERVAL_MS = 60_000;
const QUEUE_METRICS_INTERVAL_MS = 15_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function main() {
  const isWorker = process.argv.includes("--worker");

  logger.info({ env: env.NODE_ENV, isWorker }, "Starting ReachInbox backend");

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
      { email: emailWorker.id, outbox: outboxWorker.id },
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
