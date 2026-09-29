/**
 * Verify whether the stored Slack connection is usable with the current key.
 *
 * Diagnostic only: decrypts the stored token with ENCRYPTION_KEY and calls
 * auth.test. Rotating the key invalidates existing connections, so this
 * distinguishes "not connected" from "connected but undecryptable".
 */
import { createDecipheriv, scryptSync } from "crypto";
import { Client } from "pg";

const KEY = process.env.ENCRYPTION_KEY ?? "";
const URL =
  process.env.DATABASE_URL ??
  "postgresql://reachinbox:reachinbox@localhost:5432/reachinbox";

async function main() {
  const client = new Client({ connectionString: URL });
  await client.connect();

  const { rows } = await client.query(
    "select workspace_id, destination_ref, encrypted_secret_ref from slack_connections where status = 'connected' order by created_at desc limit 1",
  );
  await client.end();

  if (rows.length === 0) {
    console.log("NO CONNECTION ROW");
    return;
  }

  const row = rows[0];
  console.log(`workspace=${row.workspace_id} channel=${row.destination_ref}`);

  const key = scryptSync(KEY, "reachinbox-salt", 32);
  const data = Buffer.from(row.encrypted_secret_ref, "base64");
  const iv = data.subarray(0, 16);
  const tag = data.subarray(16, 32);
  const enc = data.subarray(32);

  let token: string;
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    token = Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    console.log("DECRYPT=FAILED (key rotated since this connection was stored)");
    return;
  }

  console.log(`DECRYPT=ok prefix=${token.slice(0, 10)}…`);

  const res = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as {
    ok: boolean;
    team?: string;
    user?: string;
    error?: string;
  };

  console.log(`AUTH_TEST ok=${json.ok} team=${json.team ?? "-"} error=${json.error ?? "-"}`);
}

main().catch((error) => {
  console.error("diagnostic failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
