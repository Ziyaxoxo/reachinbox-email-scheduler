import { createServer } from "./api/server.js";
import { env } from "./config/env.js";
import { publishMode } from "./domain/mode.js";
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
 * Three outcomes, not two, because the roles are not mutually exclusive in the
 * way the original binary assumed:
 *
 *   - `worker`     consumes, serves no HTTP. A dedicated worker service.
 *   - `api`        serves HTTP, consumes nothing. Safe at any replica count.
 *   - `hybrid`     serves HTTP *and* consumes. One process doing both.
 *
 * Worker mode wins over hybrid when both are requested, and that ordering is not
 * cosmetic: a process that serves no HTTP cannot be an API replica, so it cannot
 * be one of several competing senders.
 *
 * Hybrid exists because Render has no free background worker, so a free
 * deployment has exactly one long-lived process and it has to do both jobs. The
 * usual objection is that an API replica must never become a sender, because
 * send concurrency would then scale with replica count. That objection holds
 * generally and is why hybrid is opt-in: with several replicas, `api` is the
 * correct answer and hybrid would multiply send throughput without anyone
 * intending it. With the single instance a free tier allows, there is nothing to
 * scale.
 *
 * An operator setting `WORKER_MODE` on an API service by mistake is honoured
 * loudly rather than quietly ignored, because the symptom of getting it wrong
 * the other way, a worker that silently serves HTTP instead of consuming, is
 * invisible from outside.
 */
function resolveMode(): { isWorker: boolean; servesHttp: boolean; via: string } {
  if (process.argv.includes("--worker")) {
    return { isWorker: true, servesHttp: false, via: "argv" };
  }
  if (env.WORKER_MODE !== "") {
    return { isWorker: true, servesHttp: false, via: "env" };
  }
  if (env.EMBEDDED_WORKER !== "") {
    return { isWorker: true, servesHttp: true, via: "embedded" };
  }
  return { isWorker: false, servesHttp: true, via: "default" };
}

async function main() {
  const { isWorker, servesHttp, via } = resolveMode();

  // Published before anything can serve a request or fail, so a mode check
  // never reports the pre-resolution default.
  publishMode({ isWorker, servesHttp, via });

  logger.info(
    { env: env.NODE_ENV, isWorker, servesHttp, modeVia: via },
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
    // Imported here, not at module scope: an API replica must not become a send
    // worker unless hybrid mode was explicitly requested, or effective
    // concurrency would scale silently with the number of API pods.
    const [{ emailWorker }, { outboxWorker }] = await Promise.all([
      import("./workers/emailWorker.js"),
      import("./workers/outboxWorker.js"),
    ]);

    logger.info(
      { email: emailWorker.id, outbox: outboxWorker.id, modeVia: via },
      "Worker mode: consuming email-scheduling and outbox-events",
    );

    // A process that serves no HTTP has no /metrics to report queue depth on,
    // so it samples on an interval to keep BE-OBS-002 satisfied. A hybrid
    // process does expose metrics, but sampling either way keeps the two
    // deployments observably identical.
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
  }

  if (!servesHttp) {
    return;
  }

  if (isWorker) {
    logger.info("Hybrid mode: serving HTTP and consuming in one process");
  } else {
    logger.info("API mode: serving HTTP");
  }

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
