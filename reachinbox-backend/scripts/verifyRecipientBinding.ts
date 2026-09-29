/**
 * Verifies the Scheduled list renders real recipient addresses.
 *
 * Creates two campaigns — one single-recipient, one multi-recipient — then reads
 * the list endpoint back and asserts the recipient summary is present and
 * correct, and that a schedule id is never what the UI would have to show.
 */
import { createHmac, randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = Object.fromEntries(
  readFileSync(join(here, "..", ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const API = "http://localhost:3000";
const JWT_SECRET = process.env.JWT_SECRET ?? envFile.JWT_SECRET!;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://reachinbox:reachinbox@localhost:5432/reachinbox";

const b64url = (u: string) => Buffer.from(u).toString("base64url");

function token(userId: string): string {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64url(JSON.stringify({ sub: userId, iat: now, exp: now + 3600 }));
  const s = createHmac("sha256", JWT_SECRET)
    .update(`${h}.${p}`)
    .digest("base64url");
  return `${h}.${p}.${s}`;
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("\n=== Scheduled list recipient binding ===\n");

  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  const userId = randomUUID();
  await pg.query(
    `insert into users (id, provider_subject, email, name, created_at, updated_at)
     values ($1,$2,$3,$4,now(),now())`,
    [userId, `rbind-${Date.now()}`, `rbind-${Date.now()}@example.com`, "RB"],
  );
  await pg.end();

  const cookie = `session=${token(userId)}`;
  const startAt = new Date(Date.now() + 7_200_000).toISOString();

  const post = (body: unknown) =>
    fetch(`${API}/api/v1/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });

  const single = await post({
    subject: "single recipient campaign",
    body: "<p>hi</p>",
    recipients: ["solo-recipient@example.com"],
    startAt,
    delayMs: 0,
    hourlyLimit: 10,
    idempotencyKey: `rb-single-${Date.now()}`,
  });
  check("single-recipient campaign created", single.status === 201, `status=${single.status}`);

  const multi = await post({
    subject: "multi recipient campaign",
    body: "<p>hi</p>",
    recipients: [
      "first-of-many@example.com",
      "second@example.com",
      "third@example.com",
    ],
    startAt,
    delayMs: 0,
    hourlyLimit: 10,
    idempotencyKey: `rb-multi-${Date.now()}`,
  });
  check("multi-recipient campaign created", multi.status === 201, `status=${multi.status}`);

  const list = await (await fetch(`${API}/api/v1/schedules?limit=50`, {
    headers: { Cookie: cookie },
  })).json();

  const rows = list.items ?? [];
  check("list returned both campaigns", rows.length === 2, `rows=${rows.length}`);

  const singleRow = rows.find((r: any) => r.subject === "single recipient campaign");
  const multiRow = rows.find((r: any) => r.subject === "multi recipient campaign");

  check("single row exposes firstRecipientEmail", Boolean(singleRow?.firstRecipientEmail),
    `value=${singleRow?.firstRecipientEmail}`);
  check("single row email is the real address",
    singleRow?.firstRecipientEmail === "solo-recipient@example.com",
    `value=${singleRow?.firstRecipientEmail}`);
  check("single row recipientCount is 1", singleRow?.recipientCount === 1,
    `value=${singleRow?.recipientCount}`);

  check("multi row first recipient is lowest sequenceNo",
    multiRow?.firstRecipientEmail === "first-of-many@example.com",
    `value=${multiRow?.firstRecipientEmail}`);
  check("multi row recipientCount is 3", multiRow?.recipientCount === 3,
    `value=${multiRow?.recipientCount}`);

  // The field the UI previously fell back to must not be the only identifier.
  check("list still returns schedule id for linking",
    rows.every((r: any) => typeof r.id === "string" && r.id.length === 36));

  // Every row must carry a renderable address, so the UI never needs a fallback.
  check("every row has a non-null recipient email",
    rows.every((r: any) => typeof r.firstRecipientEmail === "string" && r.firstRecipientEmail.length > 0));

  console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exit(1);
});
