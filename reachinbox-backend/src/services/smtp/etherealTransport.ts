import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../../config/env.js";
import type { SmtpTransport, SmtpMessage, SmtpResult, SmtpError, SmtpErrorClassification } from "./transport.js";
import { logger } from "../../observability/logger.js";

export class EtherealTransport implements SmtpTransport {
  private transporter: Transporter;

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

  async send(message: SmtpMessage): Promise<SmtpResult> {
    try {
      const info = await this.transporter.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.body,
        html: message.html,
      });

      logger.info(
        { messageId: info.messageId, to: message.to },
        "Email sent successfully via Ethereal",
      );

      return {
        providerId: info.messageId,
        accepted: true,
      };
    } catch (error) {
      const smtpError = this.classifyError(error);
      logger.error(
        { err: error, to: message.to, code: smtpError.code },
        "SMTP send failed",
      );
      throw smtpError;
    }
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
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
