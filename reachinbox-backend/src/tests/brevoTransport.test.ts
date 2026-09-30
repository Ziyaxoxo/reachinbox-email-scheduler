import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Brevo is reached over HTTPS rather than SMTP, and that is forced by the host,
 * not chosen: free Render web services block outbound traffic to ports 25, 465
 * and 587, so the same credentials sent to `smtp-relay.brevo.com:587` would
 * time out exactly as they do against any other SMTP host.
 *
 * These tests assert on the request actually built rather than on the returned
 * value, because the two failure modes that matter here are both invisible in a
 * return value: a sender the provider has not verified, and a key it rejects.
 * Both look like a successful call that returned nothing useful.
 */

const env = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  SMTP_HOST: "smtp.ethereal.email",
  SMTP_PORT: 587,
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_FROM: "",
  BREVO_API_KEY: "",
  BREVO_API_URL: "https://api.brevo.com",
};

vi.mock("../config/env.js", () => ({ env }));

interface Recorded {
  url: string;
  init: RequestInit;
}

let requests: Recorded[] = [];
let response: () => Response = () =>
  new Response(JSON.stringify({ messageId: "<abc@brevo>" }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

/**
 * Re-stubbed per test rather than once at module scope: `unstubAllGlobals` in
 * afterEach would otherwise restore the real fetch after the first case, and
 * every later assertion would silently be talking to api.brevo.com.
 */
function stubFetch() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return response();
  });
}

async function freshTransport() {
  // Re-imported per test so the cached verify result does not leak between
  // cases; the transport holds state specifically to answer /health/smtp.
  vi.resetModules();
  const { BrevoTransport } = await import("../services/smtp/brevoTransport.js");
  return new BrevoTransport();
}

const message = {
  from: "user@gmail.com",
  to: "recipient@example.com",
  subject: "Subject",
  body: "Body",
};

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(requests[requests.length - 1]!.init.body));
}

function lastHeaders(): Record<string, string> {
  return requests[requests.length - 1]!.init.headers as Record<string, string>;
}

describe("Brevo transport", () => {
  beforeEach(() => {
    requests = [];
    env.BREVO_API_KEY = "xkeysib-test-key";
    env.BREVO_API_URL = "https://api.brevo.com";
    env.SMTP_FROM = "noreply@brevo.com";
    env.SMTP_USER = "";
    env.SMTP_PASS = "";
    response = () =>
      new Response(JSON.stringify({ messageId: "<abc@brevo>" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends over HTTPS, since SMTP ports are blocked on the target host", async () => {
    const transport = await freshTransport();

    await transport.send(message);

    expect(requests[0]!.url).toBe("https://api.brevo.com/v3/smtp/email");
  });

  it("authenticates with the api key header rather than SMTP credentials", async () => {
    const transport = await freshTransport();

    await transport.send(message);

    expect(lastHeaders()["api-key"]).toBe("xkeysib-test-key");
  });

  it("sends as the configured sender, not the signed-in user's address", async () => {
    const transport = await freshTransport();

    await transport.send(message);

    // The provider verifies its senders, so this address is the difference
    // between a delivered message and a 400 naming the sender field.
    expect(lastBody().sender).toEqual({ email: "noreply@brevo.com" });
  });

  it("falls back to the authenticated account when no sender is configured", async () => {
    // There is no SMTP user in this transport's normal configuration, so this
    // fallback is the only thing keeping a shared account's sender correct.
    env.SMTP_FROM = "";
    env.SMTP_USER = "account@brevo.com";
    const transport = await freshTransport();

    await transport.send(message);

    expect(lastBody().sender).toEqual({ email: "account@brevo.com" });
  });

  it("reports the provider's message id as the provider id", async () => {
    const transport = await freshTransport();

    const result = await transport.send(message);

    expect(result).toEqual({ providerId: "<abc@brevo>", accepted: true });
  });

  it("sends the body as text and adds no HTML that was not given", async () => {
    const transport = await freshTransport();

    await transport.send(message);

    const body = lastBody();
    expect(body.textContent).toBe("Body");
    // Absent rather than null: an explicit null makes Brevo treat the template
    // as HTML, which would render the body unstyled and unescaped.
    expect(body).not.toHaveProperty("htmlContent");
  });

  it("includes HTML only when the caller supplied a sanitised body", async () => {
    const transport = await freshTransport();

    await transport.send({ ...message, html: "<p>Body</p>" });

    expect(lastBody().htmlContent).toBe("<p>Body</p>");
  });

  describe("rejection handling", () => {
    it("treats a 4xx as permanent so the request is not resent unchanged", async () => {
      response = () =>
        new Response(JSON.stringify({ message: "Sender not verified" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      const transport = await freshTransport();

      // The provider names the offending field, so that text has to survive:
      // an unverified sender and an invalid key are both "400".
      await expect(transport.send(message)).rejects.toMatchObject({
        code: "HTTP_400",
        classification: "permanent",
        message: expect.stringContaining("Sender not verified"),
      });
    });

    it("treats 429 as transient, since that reply is a request to wait", async () => {
      response = () => new Response("{}", { status: 429 });
      const transport = await freshTransport();

      await expect(transport.send(message)).rejects.toMatchObject({
        classification: "transient",
      });
    });

    it("treats a 5xx as transient because the request itself was valid", async () => {
      response = () => new Response("unavailable", { status: 503 });
      const transport = await freshTransport();

      await expect(transport.send(message)).rejects.toMatchObject({
        classification: "transient",
      });
    });

    it("treats a network failure as transient rather than undeliverable", async () => {
      response = () => {
        throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
      };
      const transport = await freshTransport();

      // No provider reply exists, so nothing has been decided about this
      // message. Reporting it as permanent would silently drop real mail.
      await expect(transport.send(message)).rejects.toMatchObject({
        code: "ECONNRESET",
        classification: "transient",
      });
    });
  });

  describe("verification", () => {
    it("checks the key against an endpoint that sends no mail", async () => {
      response = () => new Response(JSON.stringify({ email: "a@b.c" }), { status: 200 });
      const transport = await freshTransport();

      await expect(transport.verify()).resolves.toBe(true);

      // Verifying by sending would itself consume quota and show up as a
      // delivered message, so the account endpoint is the only acceptable probe.
      expect(requests[0]!.url).toBe("https://api.brevo.com/v3/account");
      expect(requests[0]!.init.method).toBe("GET");
    });

    it("rejects a key the provider does not accept", async () => {
      response = () => new Response("unauthorized", { status: 401 });
      const transport = await freshTransport();

      await expect(transport.verify()).resolves.toBe(false);

      const described = transport.describe();
      expect(described.verified).toBe(false);
      expect(described.verifyError).toContain("401");
    });
  });

  describe("redacted description", () => {
    beforeEach(() => {
      env.SMTP_FROM = "";
    });

    it("never reports the key or the sender address", async () => {
      env.SMTP_FROM = "noreply@brevo.com";
      env.BREVO_API_KEY = "xkeysib-super-secret";
      const transport = await freshTransport();

      const described = JSON.stringify(transport.describe());

      expect(described).not.toContain("super-secret");
      // The endpoint is reported because it is a constant of the deployment,
      // unlike the sender, which identifies a mailbox.
      expect(described).not.toContain("noreply@brevo.com");
    });

    it("reports the transport as an api-key provider on the API endpoint", async () => {
      const transport = await freshTransport();

      expect(transport.describe()).toMatchObject({
        transport: "brevo",
        endpoint: "https://api.brevo.com",
        port: null,
        authScheme: "api-key",
        credentialsConfigured: true,
      });
    });

    it("derives secure from the endpoint rather than assuming it", async () => {
      const transport = await freshTransport();
      expect(transport.describe().secure).toBe(true);

      // A diagnostic claiming TLS on a plaintext URL would be worse than not
      // reporting the field, since it is the field an operator checks.
      env.BREVO_API_URL = "http://localhost:2525";
      const plain = await freshTransport();
      expect(plain.describe().secure).toBe(false);
    });

    it("flags the unconfigured sender separately from a missing key", async () => {
      // Distinct because they are fixed in different places, and the sender is
      // only discovered per-send, as a rejection, which reads like a provider
      // fault rather than a configuration one.
      const transport = await freshTransport();

      expect(transport.describe().credentialsConfigured).toBe(true);
      expect(transport.describe().fromSource).toBe("requested");

      env.BREVO_API_KEY = "";
      const withoutKey = await freshTransport();
      expect(withoutKey.describe().credentialsConfigured).toBe(false);
    });

    it("reports an unverified transport as unknown rather than failed", async () => {
      const transport = await freshTransport();

      // False here would report a failure that has not been observed, and would
      // send an operator hunting for one.
      expect(transport.describe().verified).toBeNull();
    });
  });
});
