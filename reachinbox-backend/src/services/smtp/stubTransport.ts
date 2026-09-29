import type {
  SmtpTransport,
  SmtpMessage,
  SmtpResult,
  SmtpError,
} from "./transport.js";
import { logger } from "../../observability/logger.js";
import { redis } from "../rateLimiter.js";

/**
 * In-process transport used by load and failure-injection runs.
 *
 * Behaves like a real provider: it consumes hourly capacity, records attempts
 * and returns a provider id, so the worker path under test is identical to
 * production.
 *
 * Every SMTP call is appended to a Redis list so a test can assert on the
 * *number of provider calls*, not just the resulting database rows. That
 * distinction matters for the ambiguity tests: proving the worker did not
 * re-send requires evidence at the transport boundary, because a second call
 * that happened to succeed would still leave plausible-looking rows.
 */
export const STUB_SEND_LOG = "test:stub:sendlog";
export const STUB_CONFIG_KEY = "test:stub:config";
export const STUB_COUNT_PREFIX = "test:stub:count:";

export interface StubConfig {
  /** Artificial per-message latency in ms. */
  latencyMs?: number;
  /** Throw this error code instead of succeeding. */
  failWith?: string;
  /** Classify the injected failure. */
  classification?: "transient" | "permanent" | "ambiguous";
  /** Fail only the first N calls, then succeed. */
  failFirstN?: number;
  /**
   * Restrict the injected failure to one recipient address.
   *
   * Required for deterministic tests: a plain counter starts at process boot,
   * so a per-process `failFirstN` is already exhausted by whatever the worker
   * happened to send first.
   */
  failRecipient?: string;
}

export interface StubSendRecord {
  at: number;
  to: string;
  outcome: "accepted" | "failed";
  providerId?: string;
  code?: string;
  classification?: string;
}

export class StubTransport implements SmtpTransport {
  private sent = 0;
  private attempts = 0;
  private readonly base: StubConfig;

  constructor(base: StubConfig = {}) {
    this.base = base;
  }

  get stats() {
    return { sent: this.sent, attempts: this.attempts };
  }

  /**
   * Failure mode is read per call so a test can flip it at runtime without
   * restarting the workers.
   */
  private async currentConfig(): Promise<StubConfig> {
    try {
      const raw = await redis.get(STUB_CONFIG_KEY);
      if (!raw) return this.base;
      return { ...this.base, ...(JSON.parse(raw) as StubConfig) };
    } catch {
      return this.base;
    }
  }

  private async log(record: StubSendRecord): Promise<void> {
    try {
      await redis.lpush(STUB_SEND_LOG, JSON.stringify(record));
      await redis.ltrim(STUB_SEND_LOG, 0, 499);
    } catch {
      // Test instrumentation must never break the send path.
    }
  }

  async send(message: SmtpMessage): Promise<SmtpResult> {
    this.attempts += 1;
    const config = await this.currentConfig();

    if (config.latencyMs) {
      await new Promise((r) => setTimeout(r, config.latencyMs));
    }

    // Scoped to one recipient when configured, so other traffic is unaffected.
    const inScope = !config.failRecipient || config.failRecipient === message.to;

    /**
     * The trip count is held in Redis, not in memory, because workers run as
     * several replicas. A per-process counter lets each replica fail its own
     * first call, so `failFirstN: 1` produces one failure *per replica* and the
     * assertion is only reproducible by accident.
     */
    let recipientAttempts = 0;
    if (config.failFirstN !== undefined) {
      try {
        recipientAttempts = await redis.incr(`${STUB_COUNT_PREFIX}${message.to}`);
      } catch {
        recipientAttempts = this.attempts;
      }
    }

    const shouldFail =
      config.failWith !== undefined &&
      inScope &&
      (config.failFirstN === undefined || recipientAttempts <= config.failFirstN);

    if (shouldFail && config.failWith !== undefined) {
      const classification = config.classification ?? "permanent";
      await this.log({
        at: Date.now(),
        to: message.to,
        outcome: "failed",
        code: config.failWith,
        classification,
      });

      throw {
        code: config.failWith,
        message: `Stub failure: ${config.failWith}`,
        classification,
      } satisfies SmtpError;
    }

    this.sent += 1;
    const providerId = `stub-${this.sent}-${Date.now()}`;

    await this.log({ at: Date.now(), to: message.to, outcome: "accepted", providerId });

    logger.debug({ providerId, to: message.to }, "Stub transport accepted message");

    return { providerId, accepted: true };
  }

  async verify(): Promise<boolean> {
    return true;
  }
}
