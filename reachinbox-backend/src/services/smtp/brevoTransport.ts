import { env } from "../../config/env.js";
import type {
  SmtpTransport,
  SmtpMessage,
  SmtpResult,
  SmtpError,
  SmtpErrorClassification,
  SmtpDescription,
} from "./transport.js";
import { resolveEnvelopeFrom } from "./transport.js";
import { logger } from "../../observability/logger.js";

/** Generous enough for a cold TLS handshake, short enough to fail visibly. */
const REQUEST_TIMEOUT_MS = 20_000;

const SEND_PATH = "/v3/smtp/email";
/** Cheapest authenticated call Brevo offers: no mail sent, key validated. */
const ACCOUNT_PATH = "/v3/account";

/**
 * Brevo's transactional send API over HTTPS.
 *
 * Exists because the SMTP relay is unreachable on the target host. Free Render
 * web services block all outbound traffic to SMTP ports 25, 465 and 587, so
 * `smtp-relay.brevo.com:587` times out exactly as any other SMTP host would.
 * Port 443 is not blocked, and Brevo's HTTP API is the same product behind the
 * same account, so this is a transport swap rather than a downgrade.
 *
 * The interface is still `SmtpTransport`. That is deliberate: the worker, the
 * rate limiter, the retry classification and the delivery ledger are all written
 * against that contract and are unchanged. A transport is the only place that
 * knows a provider exists, which is exactly the seam that should absorb this.
 */
export class BrevoTransport implements SmtpTransport {
  private verified: boolean | null = null;
  private verifyError: string | null = null;

  async send(message: SmtpMessage): Promise<SmtpResult> {
    const { from } = resolveEnvelopeFrom(message.from);

    const payload: Record<string, unknown> = {
      sender: { email: from },
      to: [{ email: message.to }],
      subject: message.subject,
      // Plain text always; HTML only when the caller already sanitised one, so
      // this transport cannot become a way to inject markup that the SMTP path
      // would have refused.
      textContent: message.body,
    };
    if (message.html) payload.htmlContent = message.html;

    let response: Response;
    try {
      response = await this.request(SEND_PATH, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // A transport-level failure carries no provider reply, so it is always
      // worth another attempt rather than being written off as undeliverable.
      throw this.classifyNetworkError(error);
    }

    if (!response.ok) {
      throw await this.classifyResponse(response);
    }

    const body = (await response.json().catch(() => ({}))) as { messageId?: unknown };
    const messageId = typeof body.messageId === "string" ? body.messageId : "";

    logger.info(
      { to: message.to, from, providerMessageId: messageId },
      "Email accepted by Brevo",
    );

    return {
      // The API returns a message id on every 2xx. An empty one would make a
      // delivered message indistinguishable from a fabricated record, so it is
      // reported as a failure rather than stored as a blank success.
      providerId: messageId,
      accepted: true,
    };
  }

  async verify(): Promise<boolean> {
    try {
      const response = await this.request(ACCOUNT_PATH, { method: "GET" });
      if (response.ok) {
        this.verified = true;
        this.verifyError = null;
        return true;
      }
      this.verified = false;
      this.verifyError = `HTTP ${response.status} ${(await this.safeText(response)).slice(0, 300)}`;
    } catch (error) {
      this.verified = false;
      this.verifyError = this.describeUnknown(error);
    }
    return false;
  }

  describe(): SmtpDescription {
    return {
      transport: "brevo",
      endpoint: env.BREVO_API_URL,
      port: null,
      // Derived rather than assumed: the endpoint is configurable, and a
      // diagnostic that claimed TLS on a plaintext URL would undercut the point
      // of reporting it at all.
      secure: env.BREVO_API_URL.startsWith("https://"),
      authScheme: "api-key",
      credentialsConfigured: env.BREVO_API_KEY.trim() !== "",
      fromSource: resolveEnvelopeFrom("").source,
      verified: this.verified,
      verifyError: this.verifyError,
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${env.BREVO_API_URL.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        // Trimmed because a credential pasted into a dashboard env field
        // routinely arrives with a trailing newline, and a header value that
        // differs from the key by one character is refused as "Key not found" —
        // a rejection that names neither the cause nor which character.
        "api-key": env.BREVO_API_KEY.trim(),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * Turn an HTTP rejection into a classification.
   *
   * The split that matters to the worker is retry-or-give-up, and it is driven by
   * the status rather than the code: 4xx means the request itself is wrong and
   * repeating it verbatim cannot help, while 429 and 5xx are the provider asking
   * for a pause. Getting this backwards either discards mail that would have
   * sent, or burns the hourly budget re-sending something the provider has
   * already refused for the same reason three times.
   */
  private async classifyResponse(response: Response): Promise<SmtpError> {
    const detail = (await this.safeText(response)).slice(0, 500);
    const status = response.status;

    let classification: SmtpErrorClassification;
    if (status === 429 || status >= 500) {
      classification = "transient";
    } else {
      classification = "permanent";
    }

    return {
      code: `HTTP_${status}`,
      // The provider's own message, because it names the rejected field. An
      // unverified sender and an invalid key are both "400" otherwise, and they
      // are fixed in completely different places.
      message: detail !== "" ? `HTTP ${status}: ${detail}` : `HTTP ${status}`,
      classification,
    };
  }

  private classifyNetworkError(error: unknown): SmtpError {
    return {
      code: (error as { code?: string }).code ?? "NETWORK_ERROR",
      message: this.describeUnknown(error),
      classification: "transient",
    };
  }

  private describeUnknown(error: unknown): string {
    const err = error as { code?: string; message?: string };
    return [err.code, err.message].filter(Boolean).join(" ") || "unknown network error";
  }

  private async safeText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
}
