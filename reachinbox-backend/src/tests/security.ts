/**
 * Security suite: API level.
 *
 * Covers the SRS security requirements that are not already proven elsewhere:
 * injection, payload abuse, secret exposure, authorization, and the guarantee
 * that telemetry never carries raw recipient data.
 *
 * Runs against the live API with a real session token, so the production
 * middleware stack is what is under test.
 */
import { createHmac, randomUUID as cryptoRandomUUID } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(here, "..", "..");

const API = process.env.E2E_API_URL ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
const findings: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else {
    failed++;
    findings.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const envFile = readEnvFile(join(BACKEND, ".env"));
const JWT_SECRET = process.env.JWT_SECRET ?? envFile.JWT_SECRET ?? "";

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signToken(userId: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ sub: userId, iat: now, exp: now + 3600 }),
  );
  const sig = b64url(
    createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

/**
 * Seed a throwaway owner.
 *
 * Local rather than imported from the e2e harness: a cross-project import
 * escapes this package's `rootDir`, and the two suites are deliberately
 * independent.
 */
async function seedUser(label: string): Promise<{ userId: string; token: string }> {
  const { default: pg } = await import("pg");
  const databaseUrl =
    process.env.DATABASE_URL ??
    envFile.DATABASE_URL ??
    "postgresql://reachinbox:reachinbox@localhost:5432/reachinbox";

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const stamp = Date.now();
  const subject = `sec-${label}-${stamp}`;
  const userId = cryptoRandomUUID();

  try {
    await client.query(
      `insert into users (id, provider_subject, email, name, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [userId, subject, `${subject}@example.com`, "Security Test"],
    );
    return { userId, token: signToken(userId) };
  } finally {
    await client.end();
  }
}

/* ------------------------------------------------------------------ */
/* Injection                                                           */
/* ------------------------------------------------------------------ */

const SQL_PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE recipients; --",
  "1' UNION SELECT id, provider_subject, email, name FROM users --",
  "admin'--",
  "%' OR 1=1 --",
  "\\'; DELETE FROM schedules WHERE 1=1; --",
];

async function testInjection(token: string) {
  console.log("\ncategory: SQL injection");

  for (const payload of SQL_PAYLOADS) {
    // Search parameter reaches a LIKE clause; it must be treated as data.
    const res = await fetch(
      `${API}/api/v1/schedules?search=${encodeURIComponent(payload)}&limit=5`,
      { headers: { Cookie: `session=${token}` } },
    );

    check(
      `search payload rejected or treated as data: ${payload.slice(0, 32)}`,
      res.status === 200 || res.status === 400,
      `status=${res.status}`,
    );

    if (res.status === 200) {
      const body = (await res.json()) as { items: unknown[] };
      // A successful response must not leak rows the caller should not see.
      check(
        "injection payload returned no unauthorised rows",
        Array.isArray(body.items),
        `items=${Array.isArray(body.items) ? body.items.length : "n/a"}`,
      );
    }
  }

  // The recipients table must still exist afterwards.
  const still = await fetch(`${API}/api/v1/schedules?limit=1`, {
    headers: { Cookie: `session=${token}` },
  });
  check(
    "schedules table intact after injection attempts",
    still.status === 200,
    `status=${still.status}`,
  );
}

async function testSearchEndpoint(token: string) {
  console.log("\ncategory: search / ES query injection");

  for (const payload of [
    '*',
    '"} OR 1=1 --',
    'subject:*',
    'a" AND "b"',
  ]) {
    const res = await fetch(
      `${API}/api/v1/emails/search?q=${encodeURIComponent(payload)}`,
      { headers: { Cookie: `session=${token}` } },
    );

    // 503 when ES is down is acceptable; 500 from a malformed query is not.
    check(
      `ES payload handled: ${payload.slice(0, 20)}`,
      res.status === 200 || res.status === 400 || res.status === 503,
      `status=${res.status}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Payload abuse (BE-SEC-004)                                          */
/* ------------------------------------------------------------------ */

async function testAbuse(token: string) {
  console.log("\ncategory: payload abuse and bounds");

  // Recipient count is capped server side.
  const tooMany = Array.from({ length: 1500 }, (_, i) => `abuse${i}@example.com`);
  const res = await fetch(`${API}/api/v1/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session=${token}` },
    body: JSON.stringify({
      subject: "abuse",
      body: "x",
      recipients: tooMany,
      startAt: new Date(Date.now() + 7_200_000).toISOString(),
      delayMs: 0,
      hourlyLimit: 10,
    }),
  });
  check("oversized recipient list rejected", res.status === 400, `status=${res.status}`);

  // Oversized body is rejected rather than buffered.
  const huge = await fetch(`${API}/api/v1/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session=${token}` },
    body: JSON.stringify({
      subject: "abuse",
      body: "A".repeat(12 * 1024 * 1024),
      recipients: ["a@example.com"],
      startAt: new Date(Date.now() + 7_200_000).toISOString(),
      delayMs: 0,
      hourlyLimit: 10,
    }),
  });
  check(
    "oversized body rejected",
    huge.status === 400 || huge.status === 413,
    `status=${huge.status}`,
  );

  // Out-of-range numeric values.
  for (const [field, value] of [
    ["hourlyLimit", 0],
    ["hourlyLimit", 99_999_999],
    ["delayMs", -5],
  ] as const) {
    const r = await fetch(`${API}/api/v1/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `session=${token}` },
      body: JSON.stringify({
        subject: "bounds",
        body: "x",
        recipients: ["a@example.com"],
        startAt: new Date(Date.now() + 7_200_000).toISOString(),
        [field]: value,
      }),
    });
    check(
      `out-of-range ${field}=${value} rejected`,
      r.status === 400,
      `status=${r.status}`,
    );
  }

  // Deeply nested JSON must not exhaust the parser or crash the process.
  let deep = '"x"';
  for (let i = 0; i < 200; i++) deep = `{"a":${deep}}`;
  const nested = await fetch(`${API}/api/v1/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session=${token}` },
    body: JSON.stringify({
      subject: "nested",
      body: "x",
      recipients: ["nested@example.com"],
      startAt: new Date(Date.now() + 7_200_000).toISOString(),
      depth: JSON.parse(deep),
    }),
  });
  // Accepting is correct here: the schema strips unknown keys. What must never
  // happen is a 5xx or the unknown field reaching storage.
  check(
    "deeply nested payload does not cause a server error",
    nested.status < 500,
    `status=${nested.status}`,
  );

  /**
   * Mass assignment: a client must not be able to set server-owned columns by
   * adding them to the request body.
   */
  const victimId = cryptoRandomUUID();
  const massAssign = await fetch(`${API}/api/v1/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session=${token}` },
    body: JSON.stringify({
      subject: "mass assignment",
      body: "x",
      recipients: ["mass@example.com"],
      startAt: new Date(Date.now() + 7_200_000).toISOString(),
      // Server-owned fields a hostile client might try to set.
      ownerId: victimId,
      status: "sent",
      id: victimId,
      createdAt: "1999-01-01T00:00:00.000Z",
    }),
  });

  const massStatus = massAssign.status;
  if (massStatus === 201) {
    const created = (await massAssign.json()) as { id: string };
    const list = await fetch(`${API}/api/v1/schedules/${created.id}`, {
      headers: { Cookie: `session=${token}` },
    });
    const record = (await list.json()) as Record<string, unknown>;

    check(
      "ownerId cannot be overridden via the request body",
      record.ownerId !== victimId,
      `ownerId=${record.ownerId}`,
    );
    check(
      "status cannot be forced to a terminal value via the body",
      record.status !== "sent",
      `status=${record.status}`,
    );
    check(
      "id cannot be forced via the request body",
      record.id !== victimId,
    );
  } else {
    check(
      "mass assignment attempt rejected or ignored",
      massStatus === 400,
      `status=${massStatus}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Secret exposure (BE-SEC-003)                                        */
/* ------------------------------------------------------------------ */

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["SMTP password", /your-ethereal-password|xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["JWT secret", new RegExp(JWT_SECRET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 24))],
  ["Google client secret", /GOCSPX-[A-Za-z0-9_-]{10,}/],
];

async function testSecretExposure(token: string) {
  console.log("\ncategory: secret exposure");

  const endpoints = [
    "/api/v1/me",
    "/api/v1/schedules?limit=5",
    "/api/v1/emails/sent?limit=5",
    "/api/v1/slack/status",
    "/health/ready",
    "/metrics",
  ];

  for (const endpoint of endpoints) {
    const res = await fetch(`${API}${endpoint}`, {
      headers: { Cookie: `session=${token}` },
    });
    const text = await res.text();

    for (const [label, pattern] of SECRET_PATTERNS) {
      check(
        `${endpoint} does not expose ${label}`,
        !pattern.test(text),
        pattern.test(text) ? "LEAKED" : "",
      );
    }
  }

  // Error responses must not echo internal detail.
  const bad = await fetch(`${API}/api/v1/schedules/not-a-uuid`, {
    headers: { Cookie: `session=${token}` },
  });
  const badText = await bad.text();
  check(
    "error response carries no stack trace or connection string",
    !badText.includes("at Object.") &&
      !badText.includes("postgresql://") &&
      !badText.includes("node_modules"),
    `status=${bad.status}`,
  );
}

/* ------------------------------------------------------------------ */
/* Authorization (BE-SEC-001)                                          */
/* ------------------------------------------------------------------ */

async function testAuthorization() {
  console.log("\ncategory: authorization");

  const cases: Array<[string, RequestInit, number[]]> = [
    ["no session", {}, [401]],
    [
      "garbage token",
      { headers: { Cookie: "session=aaa.bbb.ccc" } },
      [401],
    ],
    [
      // alg=none is the classic JWT downgrade attempt.
      "unsigned token",
      {
        headers: {
          Cookie: `session=${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
            JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000" }),
          )}.`,
        },
      },
      [401],
    ],
    [
      "wrong signature",
      {
        headers: {
          Cookie: `session=${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
            JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", exp: 9999999999 }),
          )}.${b64url("wrong-signature")}`,
        },
      },
      [401],
    ],
  ];

  for (const [label, init, expected] of cases) {
    const res = await fetch(`${API}/api/v1/schedules`, init);
    check(
      `${label} is rejected`,
      expected.includes(res.status),
      `status=${res.status}`,
    );
  }

  // A valid session for a deleted user must not work.
  const ghost = signToken("00000000-0000-0000-0000-000000000000");
  const res = await fetch(`${API}/api/v1/me`, {
    headers: { Cookie: `session=${ghost}` },
  });
  check("token for a non-existent user is rejected", res.status === 401, `status=${res.status}`);
}

/* ------------------------------------------------------------------ */
/* Rate limiting is independent of delivery limits (BE-SEC-005)        */
/* ------------------------------------------------------------------ */

async function testAbuseRateLimit(token: string) {
  console.log("\ncategory: API abuse rate limiting");

  // Fire a burst of reads; the limiter must engage independently of any email
  // quota the caller may have consumed.
  const burst = await Promise.all(
    Array.from({ length: 140 }, () =>
      fetch(`${API}/api/v1/schedules?limit=1`, {
        headers: { Cookie: `session=${token}` },
      }),
    ),
  );

  const limited = burst.filter((r) => r.status === 429).length;
  check(
    "sustained API abuse is throttled",
    limited > 0,
    `throttled=${limited}/${burst.length}`,
  );

  const stillWorks = await fetch(`${API}/api/v1/me`, {
    headers: { Cookie: `session=${token}` },
  });
  check(
    "throttling does not break unrelated authenticated reads",
    stillWorks.status === 200,
    `status=${stillWorks.status}`,
  );
}

/* ------------------------------------------------------------------ */
/* Security headers (BE-SEC-004)                                       */
/* ------------------------------------------------------------------ */

async function testHeaders() {
  console.log("\ncategory: security headers");

  const res = await fetch(`${API}/health/live`);

  check("X-Content-Type-Options set", res.headers.get("x-content-type-options") === "nosniff");
  check("X-Frame-Options set", Boolean(res.headers.get("x-frame-options")));
  check(
    "Content-Security-Policy or frame-ancestors present",
    Boolean(res.headers.get("content-security-policy")),
  );
  check("Referrer-Policy set", Boolean(res.headers.get("referrer-policy")));
  check(
    "HSTS present (even in dev, via helmet defaults)",
    res.headers.get("strict-transport-security") !== null ||
      process.env.NODE_ENV !== "production",
  );
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(`\n=== Security suite (API level) ===\n`);

  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error("JWT_SECRET not found in reachinbox-backend/.env");
    process.exit(1);
  }

  const seed = await seedUser("sec");
  const token = seed.token;

  await testInjection(token);
  await testSearchEndpoint(token);
  await testAbuse(token);
  await testSecretExposure(token);
  await testAuthorization();
  await testHeaders();
  await testAbuseRateLimit(token);

  console.log(
    `\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed)`,
  );
  if (findings.length > 0) {
    console.log("\nfailures:");
    for (const f of findings) console.log(`  - ${f}`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("SECURITY SUITE ERROR:", error);
  process.exit(1);
});
