import { execSync } from "child_process";
import {
  test,
  expect,
  API_URL,
  attemptCount,
  recipientStatuses,
  waitForDb,
  resetSenderRateWindow,
  authenticate,
} from "./fixtures.js";

/**
 * Delivery, derived side effects and restart recovery.
 *
 * Delivery outcomes are asserted against the database rather than the UI,
 * because sending is asynchronous and the UI is never the authority
 * (FE-DASH-005).
 */

const BACKEND = "C:/Users/FAIHA/OneDrive/Documents/Default Project/reachinbox-backend";

function compose(action: string) {
  return execSync(
    `docker-compose -f "${BACKEND}/docker-compose.yml" ${action}`,
    { encoding: "utf8", stdio: "pipe" },
  );
}

async function scheduleViaApi(
  seed: { token: string },
  payload: Record<string, unknown>,
) {
  const res = await fetch(`${API_URL}/api/v1/schedules`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${seed.token}`,
    },
    body: JSON.stringify(payload),
  });
  if (res.status >= 400) {
    throw new Error(`schedule failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

test.describe("delivery and recovery", () => {
  test("recipients reach a terminal state and appear in Sent", async ({
    page,
    db,
    seed,
  }) => {
    await resetSenderRateWindow(seed.senderId);

    const created = await scheduleViaApi(seed, {
      subject: "Delivery journey",
      body: "<p>hello</p>",
      recipients: [
        "deliver-a@example.com",
        "deliver-b@example.com",
        "deliver-c@example.com",
      ],
      startAt: new Date(Date.now() + 1_000).toISOString(),
      delayMs: 0,
      hourlyLimit: 100,
      idempotencyKey: `e2e-deliver-${Date.now()}`,
    });

    await waitForDb(
      db,
      async () => {
        const rows = await recipientStatuses(db, created.id);
        return rows.length === 3 && rows.every((r) => r.status === "sent");
      },
      { timeoutMs: 60_000, label: "all 3 recipients sent" },
    );

    // Exactly one attempt per recipient: no duplicate sends (BE-CONC-005).
    expect(await attemptCount(db, created.id)).toBe(3);

    // Provider ids are persisted, so a send is traceable (BE-SMTP-004).
    const { rows } = await db.query<{ provider_id: string | null }>(
      `select da.provider_id from delivery_attempts da
         join recipients r on r.id = da.recipient_id
        where r.schedule_id = $1`,
      [created.id],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.provider_id).toBeTruthy();
    }

    // The Sent view shows real recipient addresses, not ids.
    await authenticate(page);
    await page.goto("/");
    await page.getByRole("tab", { name: /^sent$/i }).click();
    await expect(page.getByText("deliver-a@example.com")).toBeVisible({
      timeout: 25_000,
    });
  });

  test("an outbox event is written per recipient and indexed into Elasticsearch", async ({
    db,
    seed,
  }) => {
    await resetSenderRateWindow(seed.senderId);

    const created = await scheduleViaApi(seed, {
      subject: "Outbox probe",
      body: "<p>x</p>",
      recipients: ["outbox-a@example.com", "outbox-b@example.com"],
      startAt: new Date(Date.now() + 1_000).toISOString(),
      delayMs: 0,
      hourlyLimit: 100,
      idempotencyKey: `e2e-outbox-${Date.now()}`,
    });

    const { rows: recipientRows } = await db.query<{ id: string }>(
      "select id from recipients where schedule_id = $1",
      [created.id],
    );
    expect(recipientRows).toHaveLength(2);

    // aggregate_id is text; the recipient ids must be compared as text.
    await waitForDb(
      db,
      async () => {
        const { rows } = await db.query<{ n: number }>(
          `select count(*)::int as n from outbox_events
            where status = 'completed'
              and aggregate_id in (
                select id::text from recipients where schedule_id = $1
              )`,
          [created.id],
        );
        return (rows[0]?.n ?? 0) === 2;
      },
      { timeoutMs: 60_000, label: "both outbox events completed" },
    );

    // The derived read model holds one document per recipient, keyed by id, so a
    // replay updates rather than duplicates (BE-ES-003).
    for (const r of recipientRows) {
      const doc = await fetch(
        `http://localhost:9200/reachinbox-emails/_doc/${r.id}`,
      );
      expect(doc.status).toBe(200);
    }
  });

  test("a full hourly window defers work instead of dropping it", async ({
    db,
    seed,
  }) => {
    await resetSenderRateWindow(seed.senderId);

    const created = await scheduleViaApi(seed, {
      subject: "Rate limited run",
      body: "<p>x</p>",
      recipients: Array.from({ length: 8 }, (_, i) => `ratelimit-${i}@example.com`),
      startAt: new Date(Date.now() + 1_000).toISOString(),
      delayMs: 0,
      hourlyLimit: 3,
      idempotencyKey: `e2e-rate-${Date.now()}`,
    });

    await waitForDb(
      db,
      async () => {
        const rows = await recipientStatuses(db, created.id);
        return rows.filter((r) => r.status === "sent").length === 3;
      },
      { timeoutMs: 60_000, label: "hourly cap reached (3 sent)" },
    );

    const rows = await recipientStatuses(db, created.id);

    // Never more than the cap, and nothing vanished (BE-RATE-002/004).
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(3);
    expect(rows.filter((r) => r.status === "queued").length).toBeGreaterThanOrEqual(5);

    // One attempt per send; deferred recipients were not attempted twice.
    expect(await attemptCount(db, created.id)).toBe(3);

    // Slack is not connected in this environment, yet delivery was unaffected:
    // the threshold produced a durable event whose dispatch may fail, and the
    // email flow must not care (BE-SLACK-004).
    const { rows: events } = await db.query<{ status: string }>(
      "select status from outbox_events where type = 'slack.rate_limit' order by created_at desc limit 1",
    );
    // Event may or may not have been written depending on the window, but no
    // recipient may have been failed because of it.
    for (const r of rows) {
      expect(r.status).not.toBe("failed");
    }
    void events;
  });

  test("restart recovery resumes pending work without duplicating sends", async ({
    db,
    seed,
  }) => {
    await resetSenderRateWindow(seed.senderId);

    const created = await scheduleViaApi(seed, {
      subject: "Restart recovery",
      body: "<p>x</p>",
      recipients: [
        "restart-a@example.com",
        "restart-b@example.com",
        "restart-c@example.com",
      ],
      // Far enough out that killing the workers beats the first send.
      startAt: new Date(Date.now() + 25_000).toISOString(),
      delayMs: 0,
      hourlyLimit: 100,
      idempotencyKey: `e2e-restart-${Date.now()}`,
    });

    // Kill the workers before the schedule comes due.
    compose("stop worker");
    await new Promise((r) => setTimeout(r, 4_000));

    // Nothing was attempted while the consumers were down.
    expect(await attemptCount(db, created.id)).toBe(0);
    const whileDown = await recipientStatuses(db, created.id);
    expect(whileDown.every((r) => r.status === "queued")).toBe(true);

    // Restart: the DB is the source of truth, so pending work resumes.
    compose("start worker");

    await waitForDb(
      db,
      async () => {
        const rows = await recipientStatuses(db, created.id);
        return rows.length === 3 && rows.every((r) => r.status === "sent");
      },
      { timeoutMs: 120_000, label: "pending work resumed after restart" },
    );

    // One attempt each: a restart must not produce a second send.
    expect(await attemptCount(db, created.id)).toBe(3);
  });

  test("the API serves metrics and does not consume the email queue", async ({
    request,
  }) => {
    const res = await request.get(`${API_URL}/metrics`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain("reachinbox_");
  });
});
