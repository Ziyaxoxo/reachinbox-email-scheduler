import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../../config/env.js";
import type {
  SmtpTransport,
  SmtpMessage,
  SmtpResult,
  SmtpError,
  SmtpErrorClassification,
  SmtpDescription,
} from "./transport.js";
import { logger } from "../../observability/logger.js";

export class EtherealTransport implements SmtpTransport {
  private transporter: Transporter;
  private verified: boolean | null = null;
  private verifyError: string | null = null;
  private loggedFromOverride = false;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }

  /**
   * The address the message is actually sent from.
   *
   * The worker asks to send as the per-user sender address, which is the user's
   * own login email. A provider will only send from the mailbox its credentials
   * authenticate as, so on a shared relay account that address is rejected
   * however correct the credentials are. Pinning the envelope to the
   * authenticated account is what makes the send actually happen.
   *
   * Falls back to the requested address when no account is configured, so a
   * missing-credential deployment behaves exactly as it did before rather than
   * silently sending as `undefined`.
   */
  private effectiveFrom(requested: string): string {
    const configured = env.SMTP_FROM.trim();
    if (configured !== "") return configured;
    const account = env.SMTP_USER.trim();
    if (account !== "") return account;
    return requested;
  }

  async send(message: SmtpMessage): Promise<SmtpResult> {
    const from = this.effectiveFrom(message.from);

    if (from !== message.from && !this.loggedFromOverride) {
      // Once per process, not per send: this is a configuration fact, and
      // logging it on every message would bury the actual send failures.
      this.loggedFromOverride = true;
      logger.info(
        { requested: message.from, effectiveFrom: from },
        "Sending from the authenticated SMTP account rather than the per-user sender address",
      );
    }

    try {
      const info = await this.transporter.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.body,
        html: message.html,
      });

      logger.info(
        { messageId: info.messageId, to: message.to, from },
        "Email sent successfully via Ethereal",
      );

      return {
        providerId: info.messageId,
        accepted: true,
      };
    } catch (error) {
      const smtpError = this.classifyError(error);
      logger.error(
        { err: error, to: message.to, from, code: smtpError.code },
        "SMTP send failed",
      );
      throw smtpError;
    }
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      this.verified = true;
      this.verifyError = null;
      return true;
    } catch (error) {
      const err = error as { message?: string; code?: string; responseCode?: number };
      this.verified = false;
      // The response code is the whole diagnosis: 530 means no credentials were
      // offered at all, 535 means they were offered and refused. Both arrive
      // here with the same generic code, so the message is retained verbatim.
      this.verifyError = [err.code, err.responseCode, err.message]
        .filter((part) => part !== undefined && part !== "")
        .join(" ");
      return false;
    }
  }

  describe(): SmtpDescription {
    return {
      transport: "ethereal",
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      userConfigured: env.SMTP_USER.trim() !== "",
      passConfigured: env.SMTP_PASS.trim() !== "",
      fromSource:
        env.SMTP_FROM.trim() !== ""
          ? "configured"
          : env.SMTP_USER.trim() !== ""
            ? "authenticated-account"
            : "requested",
      verified: this.verified,
      verifyError: this.verifyError,
    };
  }

  private classifyError(error: unknown): SmtpError {
    const err = error as { code?: string; message?: string; responseCode?: number };
    const code = err.code || "UNKNOWN";
    const message = err.message || "Unknown SMTP error";

    let classification: SmtpErrorClassification = "permanent";

    // Transient errors (4xx SMTP codes, network issues)
    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      (err.responseCode && err.responseCode >= 400 && err.responseCode < 500)
    ) {
      classification = "transient";
    }

    // Ambiguous errors (connection lost after send)
    if (code === "ECONNRESET" || code === "EPIPE") {
      classification = "ambiguous";
    }

    return { code, message, classification };
  }
}
