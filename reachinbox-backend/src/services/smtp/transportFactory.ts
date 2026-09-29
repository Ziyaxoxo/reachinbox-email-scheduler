import type { SmtpTransport } from "./transport.js";
import { EtherealTransport } from "./etherealTransport.js";
import { StubTransport } from "./stubTransport.js";
import { env } from "../../config/env.js";
import { logger } from "../../observability/logger.js";

let instance: SmtpTransport | null = null;

/**
 * Transport selection is config-driven (BE-SCHED / config section of the SRS),
 * so the same worker code path runs against a real provider or the in-process
 * stub used by load and failure-injection runs.
 */
export function getSmtpTransport(): SmtpTransport {
  if (instance) return instance;

  if (env.SMTP_TRANSPORT === "stub") {
    logger.warn(
      "SMTP_TRANSPORT=stub — messages are not actually delivered (load/failure testing only)",
    );
    const latency = Number(process.env.SMTP_STUB_LATENCY_MS ?? 0);
    instance = new StubTransport({ latencyMs: Number.isFinite(latency) ? latency : 0 });
  } else {
    instance = new EtherealTransport();
  }

  return instance;
}
