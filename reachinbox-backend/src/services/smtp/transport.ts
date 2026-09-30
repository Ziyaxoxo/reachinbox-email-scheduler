export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  html?: string;
}

export interface SmtpResult {
  providerId: string;
  accepted: boolean;
}

export type SmtpErrorClassification = "transient" | "permanent" | "ambiguous";

export interface SmtpError {
  code: string;
  message: string;
  classification: SmtpErrorClassification;
}

/**
 * Redacted description of how the transport is configured.
 *
 * This exists because SMTP misconfiguration is invisible from the outside in the
 * worst possible way: the worker records `failed` rows carrying `EENVELOPE`,
 * the dashboard renders normally, and the only record of what the provider
 * actually replied is one line in the deploy log competing with unrelated
 * noise. The two causes need completely different fixes and are told apart by a
 * single character in the reply, so guessing is not an option.
 *
 * Credentials are reported as present/absent and never by value, so this is
 * safe to serve from an unauthenticated health route.
 */
export interface SmtpDescription {
  transport: "ethereal" | "stub";
  host: string | null;
  port: number | null;
  secure: boolean;
  /** Credentials arrived as non-empty strings. Values are never reported. */
  userConfigured: boolean;
  passConfigured: boolean;
  /**
   * Which address supplies the envelope From.
   *
   * `requested` means the per-user sender address is being used as-is, which is
   * only correct when the authenticated account is entitled to send as it. On a
   * shared relay account that is not the case, so `requested` is the signal
   * that either credentials are missing or the From will be rejected.
   */
  fromSource: "configured" | "authenticated-account" | "requested";
  /** Last `verify()` result, or null if it has not completed yet. */
  verified: boolean | null;
  /** Provider's reply from the last `verify()`, for the failing case only. */
  verifyError: string | null;
}

export interface SmtpTransport {
  send(message: SmtpMessage): Promise<SmtpResult>;
  verify(): Promise<boolean>;
  describe(): SmtpDescription;
}
