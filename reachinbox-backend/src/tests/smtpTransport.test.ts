import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The envelope From is a correctness constraint, not a cosmetic one.
 *
 * The worker asks to send as the per-user sender address, which is the user's
 * own login email. A provider only sends from the mailbox its credentials
 * authenticate as, so on a shared relay account that From is rejected however
 * correct the credentials are. This went unnoticed because the failure is
 * indistinguishable from bad credentials at the call site: both arrive as
 * EENVELOPE, the worker records `failed`, and the dashboard looks healthy.
 */

const env = {
  // The real logger is constructed from this same module, so these two are not
  // optional here: omitting them fails the import rather than the assertion.
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  SMTP_HOST: "smtp.ethereal.email",
  SMTP_PORT: 587,
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_FROM: "",
};

vi.mock("../config/env.js", () => ({ env }));

// Captures what nodemailer was actually asked to send, so the assertion is on
// the wire format rather than on the implementation's intent.
const sent: Array<Record<string, unknown>> = [];
let verifyImpl: () => Promise<void> = async () => {};
let sendImpl: () => Promise<{ messageId: string }> = async () => ({
  messageId: "test-message-id",
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
        return sendImpl();
      },
      verify: () => verifyImpl(),
    }),
  },
}));

async function freshTransport() {
  // Imported per test so module-level state (the once-per-process From log and
  // the cached verify result) does not leak between cases.
  vi.resetModules();
  const { EtherealTransport } = await import(
    "../services/smtp/etherealTransport.js"
  );
  return new EtherealTransport();
}

const message = {
  from: "user@gmail.com",
  to: "recipient@example.com",
  subject: "Subject",
  body: "Body",
};

describe("envelope From address", () => {
  beforeEach(() => {
    sent.length = 0;
    env.SMTP_USER = "";
    env.SMTP_PASS = "";
    env.SMTP_FROM = "";
    sendImpl = async () => ({ messageId: "test-message-id" });
    verifyImpl = async () => {};
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends as the authenticated account, not the user's address", async () => {
    env.SMTP_USER = "demo@ethereal.email";
    env.SMTP_PASS = "secret";
    const transport = await freshTransport();

    await transport.send(message);

    // The assertion that matters: not the caller's From, and not undefined.
    expect(sent[0]!.from).toBe("demo@ethereal.email");
  });

  it("prefers an explicitly configured From over the account", async () => {
    env.SMTP_USER = "demo@ethereal.email";
    env.SMTP_PASS = "secret";
    env.SMTP_FROM = "outbound@example.org";
    const transport = await freshTransport();

    await transport.send(message);

    expect(sent[0]!.from).toBe("outbound@example.org");
  });

  it("falls back to the requested address when no account is configured", async () => {
    // Preserves pre-existing behaviour for a deployment with no credentials, so
    // the change cannot make a broken configuration worse than it already was.
    const transport = await freshTransport();

    await transport.send(message);

    expect(sent[0]!.from).toBe("user@gmail.com");
  });

  it("trims whitespace so a pasted value cannot become the From", async () => {
    env.SMTP_USER = "  demo@ethereal.email  ";
    env.SMTP_FROM = "  outbound@example.org\n";
    const transport = await freshTransport();

    await transport.send(message);

    expect(sent[0]!.from).toBe("outbound@example.org");
  });
});

describe("redacted description", () => {
  beforeEach(() => {
    env.SMTP_USER = "";
    env.SMTP_PASS = "";
    env.SMTP_FROM = "";
    sendImpl = async () => ({ messageId: "test-message-id" });
    verifyImpl = async () => {};
  });

  it("reports credentials as present or absent but never by value", async () => {
    env.SMTP_USER = "demo@ethereal.email";
    env.SMTP_PASS = "super-secret";
    const transport = await freshTransport();

    const described = JSON.stringify(transport.describe());

    expect(described).not.toContain("super-secret");
    expect(described).not.toContain("demo@ethereal.email");
    expect(transport.describe().userConfigured).toBe(true);
    expect(transport.describe().passConfigured).toBe(true);
  });

  it("reports missing credentials as not configured", async () => {
    const transport = await freshTransport();

    expect(transport.describe().userConfigured).toBe(false);
    expect(transport.describe().passConfigured).toBe(false);
    expect(transport.describe().fromSource).toBe("requested");
  });

  it("distinguishes an unverified transport from a verified one", async () => {
    const transport = await freshTransport();

    // Unknown, not false: nothing has been proven yet, and reporting false
    // would send an operator hunting for a failure that has not happened.
    expect(transport.describe().verified).toBeNull();

    await transport.verify();

    expect(transport.describe().verified).toBe(true);
    expect(transport.describe().verifyError).toBeNull();
  });

  it("keeps the provider's refusal verbatim, since the code is the diagnosis", async () => {
    verifyImpl = async () => {
      throw Object.assign(new Error("530 Error: authentication Required"), {
        code: "EENVELOPE",
        responseCode: 530,
      });
    };
    const transport = await freshTransport();

    await expect(transport.verify()).resolves.toBe(false);

    // 530 (no credentials offered) and 535 (credentials refused) need opposite
    // fixes, so the number has to survive.
    const described = transport.describe();
    expect(described.verified).toBe(false);
    expect(described.verifyError).toContain("530");
  });

  it("classifies a 4xx reply as transient so the worker retries", async () => {
    sendImpl = async () => {
      throw Object.assign(new Error("421 Service not available"), {
        code: "EENVELOPE",
        responseCode: 421,
      });
    };
    env.SMTP_USER = "demo@ethereal.email";
    const transport = await freshTransport();

    // The worker branches on `classification`, not on the code, so this is the
    // value that decides retry versus terminal failure.
    await expect(transport.send(message)).rejects.toMatchObject({
      code: "EENVELOPE",
      classification: "transient",
    });
  });

  it("classifies a 5xx reply as permanent so the worker stops retrying", async () => {
    sendImpl = async () => {
      throw Object.assign(new Error("550 Sender address not owned"), {
        code: "EENVELOPE",
        responseCode: 550,
      });
    };
    env.SMTP_USER = "demo@ethereal.email";
    const transport = await freshTransport();

    await expect(transport.send(message)).rejects.toMatchObject({
      classification: "permanent",
    });
  });
});