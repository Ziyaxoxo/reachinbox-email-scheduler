import type { Worker } from "bullmq";
import { logger } from "../observability/logger.js";
import { pool } from "../db/client.js";
import { redisConnection } from "../queue/connection.js";

/**
 * Workers are registered here rather than imported statically, so an API
 * process never instantiates a consumer. Importing the worker modules for their
 * side effect is what previously made every API replica a send worker and made
 * effective concurrency an unpredictable multiple of the replica count.
 */
const activeWorkers: Worker[] = [];

export function registerWorker(worker: Worker): void {
  activeWorkers.push(worker);
}

export async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(
    { signal, workers: activeWorkers.length },
    "Starting graceful shutdown",
  );

  try {
    // Stop accepting new work, then let in-flight jobs finish.
    await Promise.all(activeWorkers.map((w) => w.close()));
    logger.info({ count: activeWorkers.length }, "Workers closed");

    await pool.end();
    logger.info("Database pool closed");

    await redisConnection.quit();
    logger.info("Redis connection closed");

    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Error during graceful shutdown");
    process.exit(1);
  }
}

export function setupGracefulShutdown(): void {
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
}
