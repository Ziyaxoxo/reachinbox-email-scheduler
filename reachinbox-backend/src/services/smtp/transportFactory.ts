import type { SmtpTransport } from "./transport.js";
import { EtherealTransport } from "./etherealTransport.js";
import { BrevoTransport } from "./brevoTransport.js";
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
  } else if (env.SMTP_TRANSPORT === "brevo") {
    // Brevo is reached over HTTPS rather than SMTP, which is not a stylistic
    // choice: free Render web services block outbound traffic to ports 25, 465
    // and 587 entirely, so the SMTP relay is unreachable there no matter which
    // credentials it is given.
    instance = new BrevoTransport();
  } else {
    instance = new EtherealTransport();
  }

  return instance;
}
