import { env } from "../../config/env.js";

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

/** Which address supplied the envelope sender. */
export type FromSource = "configured" | "authenticated-account" | "requested";

/**
 * Decide the address a message is actually sent from.
 *
 * A provider will only send from a mailbox it is entitled to send from, so the
 * per-user address the caller asks for is frequently not sendable at all. The
 * precedence is deliberate:
 *
 *   1. `SMTP_FROM` — an explicit choice by whoever configured the deployment.
 *   2. `SMTP_USER` — the account the credentials authenticate as, which is the
 *      only address an SMTP relay is guaranteed to be allowed to use.
 *   3. the requested address — preserves pre-existing behaviour when no account
 *      is configured, so a credential-less deployment is not made worse.
 *
 * Shared by both real transports so they cannot drift. It matters most for the
 * HTTP transport, which has no SMTP user at all: there, an unset `SMTP_FROM` is
 * the only thing standing between the send and a rejected sender, and the
 * fallbacks below are what keep it honest instead of silently sending as the
 * signed-in user's address.
 */
export function resolveEnvelopeFrom(requested: string): { from: string; source: FromSource } {
  const configured = env.SMTP_FROM.trim();
  if (configured !== "") return { from: configured, source: "configured" };

  const account = env.SMTP_USER.trim();
  if (account !== "") return { from: account, source: "authenticated-account" };

  return { from: requested, source: "requested" };
}

export interface SmtpError {
  code: string;
  message: string;
  classification: SmtpErrorClassification;
}

/**
 * Redacted description of how the transport is configured.
 *
 * This exists because mail misconfiguration is invisible from the outside in
 * the worst possible way: the worker records `failed` rows carrying a single
 * opaque code, the dashboard renders normally, and the only record of what the
 * provider actually replied is one line in the deploy log competing with
 * unrelated noise. The possible causes have completely different fixes, so the
 * configuration has to be readable from a URL rather than inferred.
 *
 * Credentials are reported as present/absent and never by value, which is what
 * makes this safe to serve from an unauthenticated health route.
 */
export interface SmtpDescription {
  transport: "ethereal" | "brevo" | "stub";
  /** Provider endpoint. Null for the stub, which has no provider. */
  endpoint: string | null;
  /** Port for an SMTP transport; null for the HTTP transport and the stub. */
  port: number | null;
  secure: boolean;
  /** How the provider is authenticated. */
  authScheme: "smtp" | "api-key" | "none";
  /**
   * The credential arrived as a non-empty string. The value is never reported.
   *
   * A single flag rather than one per field because the two transports
   * authenticate differently: SMTP has a user and a password, the HTTP API has
   * one key. Reporting the wrong pair for the transport in use is how a
   * correctly configured deployment gets read as broken.
   */
  credentialsConfigured: boolean;
  /**
   * Which address supplies the envelope From.
   *
   * `requested` means the per-user sender address is being used as-is, which is
   * only correct when the signed-in user genuinely owns that address. On a
   * shared provider account it is not, so `requested` is the signal that the
   * sender is misconfigured and every send will be rejected.
   */
  fromSource: FromSource;
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
