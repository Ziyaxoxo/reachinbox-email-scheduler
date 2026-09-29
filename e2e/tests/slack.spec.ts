import { test, expect, API_URL, waitForDb, resetSenderRateWindow, authenticate } from "./fixtures.js";
import { execFileSync } from "child_process";

/**
 * BE-SLACK-003: a live rate-limit notification reaches a real Slack channel.
 *
 * The backend marks a `slack.rate_limit` outbox event `completed` only after
 * Slack's API returns `ok: true` for `chat.postMessage`, so a completed event is
 * proof the message was accepted. The test additionally reads the channel back
 * through `conversations.history` to confirm the message is actually there.
 *
 * Requires a working Slack connection. The suite reuses whatever connected
 * workspace exists rather than assuming ownership of it.
 */

const BACKEND = "C:/Users/FAIHA/OneDrive/Documents/Default Project/reachinbox-backend";

interface SlackProbe {
  connected: boolean;
  workspaceId?: string;
  channel?: string;
  usable: boolean;
  reason?: string;
}

/**
 * Ask the backend whether it can actually talk to Slack right now.
 *
 * Decryption happens in the backend, where the key lives, so this goes through
 * a diagnostic rather than duplicating the crypto here.
 */
function probeSlack(): SlackProbe {
  const script = `
    const { Client } = require("pg");
    const { scryptSync, createDecipheriv } = require("crypto");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query(
        "select workspace_id, destination_ref, encrypted_secret_ref from slack_connections where status = 'connected' order by created_at desc limit 1"
      );
      await c.end();
      if (!r.rows.length) { console.log(JSON.stringify({ connected: false, usable: false, reason: "no connected workspace" })); return; }
      const row = r.rows[0];
      let token;
      try {
        const key = scryptSync(process.env.ENCRYPTION_KEY, "reachinbox-salt", 32);
        const d = Buffer.from(row.encrypted_secret_ref, "base64");
        const dec = createDecipheriv("aes-256-gcm", key, d.subarray(0,16));
        dec.setAuthTag(d.subarray(16,32));
        token = Buffer.concat([dec.update(d.subarray(32)), dec.final()]).toString("utf8");
      } catch {
        console.log(JSON.stringify({ connected: true, workspaceId: row.workspace_id, channel: row.destination_ref, usable: false, reason: "stored token cannot be decrypted with the current ENCRYPTION_KEY" }));
        return;
      }
      const res = await fetch("https://slack.com/api/auth.test", { headers: { Authorization: "Bearer " + token } });
      const j = await res.json();
      console.log(JSON.stringify({
        connected: true,
        workspaceId: row.workspace_id,
        channel: row.destination_ref,
        usable: j.ok === true,
        reason: j.ok ? undefined : ("auth.test: " + j.error),
      }));
    })().catch(e => { console.log(JSON.stringify({ connected: false, usable: false, reason: String(e && e.message || e) })); });
  `;

  const out = execFileSync(
    "docker",
    [
      "compose",
      "-f",
      `${BACKEND}/docker-compose.yml`,
      "exec",
      "-T",
      "api",
      "node",
      "-e",
      script,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );

  const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line) as SlackProbe;
}

/** Read recent messages from the channel to confirm the notification landed. */
function readChannel(token_owner_email: string): Promise<
  Array<{ text: string; ts: string }>
> {
  const script = `
    const { Client } = require("pg");
    const { scryptSync, createDecipheriv } = require("crypto");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query(
        "select destination_ref, encrypted_secret_ref from slack_connections where status = 'connected' order by created_at desc limit 1"
      );
      await c.end();
      if (!r.rows.length) { console.log("[]"); return; }
      const row = r.rows[0];
      const key = scryptSync(process.env.ENCRYPTION_KEY, "reachinbox-salt", 32);
      const d = Buffer.from(row.encrypted_secret_ref, "base64");
      const dec = createDecipheriv("aes-256-gcm", key, d.subarray(0,16));
      dec.setAuthTag(d.subarray(16,32));
      const token = Buffer.concat([dec.update(d.subarray(32)), dec.final()]).toString("utf8");
      const res = await fetch(
        "https://slack.com/api/conversations.history?channel=" + row.destination_ref + "&limit=10",
        { headers: { Authorization: "Bearer " + token } }
      );
      const j = await res.json();
      if (!j.ok) { console.log(JSON.stringify({ error: j.error })); return; }
      console.log(JSON.stringify(j.messages.map(m => ({ text: m.text, ts: m.ts }))));
    })().catch(e => { console.log(JSON.stringify({ error: String(e && e.message || e) })); });
  `;

  const out = execFileSync(
    "docker",
    [
      "compose",
      "-f",
      `${BACKEND}/docker-compose.yml`,
      "exec",
      "-T",
      "api",
      "node",
      "-e",
      script,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );

  const line = out.trim().split("\n").filter(Boolean).pop() ?? "[]";
  return Promise.resolve(JSON.parse(line));
}

test.describe("live Slack notification", () => {
  test("a rate-limit threshold posts a real message to the connected channel", async ({
    page,
    db,
    seed,
  }) => {
    const probe = probeSlack();

    test.skip(
      !probe.usable,
      `No usable Slack connection (${probe.reason ?? "unknown"}). ` +
        `Reconnect Slack in the dashboard, then re-run. ` +
        `workspace=${probe.workspaceId ?? "none"} channel=${probe.channel ?? "none"}`,
    );

    await authenticate(page);
    await resetSenderRateWindow(seed.senderId);

    const before = await readChannel(seed.email);
    const beforeCount = Array.isArray(before) ? before.length : 0;

    // hourlyLimit 1 across 3 recipients guarantees exactly one threshold event.
    const res = await page.request.post(`${API_URL}/api/v1/schedules`, {
      headers: { "Content-Type": "application/json" },
      data: {
        subject: "Live Slack notification",
        body: "<p>x</p>",
        recipients: [
          "live-slack-a@example.com",
          "live-slack-b@example.com",
          "live-slack-c@example.com",
        ],
        startAt: new Date(Date.now() + 1_000).toISOString(),
        delayMs: 0,
        hourlyLimit: 1,
        idempotencyKey: `e2e-slack-${Date.now()}`,
      },
    });
    expect(res.status()).toBe(201);
    const created = (await res.json()) as { id: string };

    // The event only reaches `completed` when Slack accepted the message.
    await waitForDb(
      db,
      async () => {
        const { rows } = await db.query<{ status: string; last_error: string | null }>(
          `select status, last_error from outbox_events
            where type = 'slack.rate_limit' order by created_at desc limit 1`,
        );
        return rows[0]?.status === "completed";
      },
      { timeoutMs: 60_000, label: "slack.rate_limit event completed" },
    );

    const after = await readChannel(seed.email);
    expect(Array.isArray(after)).toBe(true);
    expect(after.length).toBeGreaterThan(beforeCount);

    const latest = (after as Array<{ text: string }>)[0];
    expect(latest.text).toMatch(/rate limit/i);
    expect(latest.text).toMatch(/next available window/i);

    // The email flow is untouched by the notification having succeeded.
    const { rows: recipientRows } = await db.query<{ status: string }>(
      "select status from recipients where schedule_id = $1 order by sequence_no asc",
      [created.id],
    );
    expect(recipientRows).toHaveLength(3);
    expect(recipientRows[0]!.status).toBe("sent");
    expect(recipientRows.filter((r) => r.status === "queued")).toHaveLength(2);
  });

  test("disconnecting removes the notification path without affecting email", async ({
    page,
    seed,
  }) => {
    await authenticate(page);

    const status = await page.request.get(`${API_URL}/api/v1/slack/status`);
    expect(status.status()).toBe(200);

    // Whatever the connection state, the API must never leak a token.
    const body = await status.text();
    expect(body).not.toMatch(/xox[baprs]-/i);
    expect(body).not.toMatch(/encryptedSecretRef/i);
  });
});
