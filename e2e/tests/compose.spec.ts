import { test, expect, authenticate, getDb } from "./fixtures.js";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * The primary product journey, driven through the real UI:
 * compose, upload recipients, schedule, observe the result.
 *
 * Requires the workers on SMTP_TRANSPORT=stub so delivery does not need real
 * SMTP credentials.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(here, "..", "test-results");

function fixture(name: string, contents: string): string {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = join(ARTIFACTS, name);
  writeFileSync(file, contents, "utf8");
  return file;
}

const API = process.env.E2E_API_URL ?? "http://localhost:3000";

/**
 * Open the schedule picker and choose a future slot.
 *
 * Uses the "Tomorrow" quick-select option rather than typing into the native
 * date input: it is the path a real user takes, and it is deterministic
 * regardless of what time of day the suite runs.
 */
async function pickFutureDate(page: import("@playwright/test").Page) {
  const tomorrow = new Date(Date.now() + 86_400_000);

  await page.getByRole("button", { name: /schedule send time/i }).click();
  await page.getByRole("button", { name: /tomorrow/i }).click();

  // The trigger must reflect the new, unambiguously future value.
  await expect(
    page.getByRole("button", { name: /schedule send time/i }),
  ).toContainText(String(tomorrow.getDate()), { timeout: 10_000 });
}

test.describe("compose and schedule", () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test("an empty form cannot be submitted and creates nothing", async ({
    page,
    seed,
  }) => {
    const db = await getDb();
    const countSchedules = async () => {
      const { rows } = await db.query<{ n: number }>(
        "select count(*)::int as n from schedules where owner_id = $1",
        [seed.userId],
      );
      return rows[0]?.n ?? 0;
    };

    // Compare against a baseline: other tests in this file create schedules for
    // the same owner, so an absolute zero would be order dependent.
    const before = await countSchedules();

    await page.goto("/");
    await page.getByRole("button", { name: /^compose$/i }).first().click();

    await expect(
      page.getByRole("heading", { name: /compose new email/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: /schedule email/i }).click();

    // Inline validation rather than a silent accept (FE-COMP-001).
    await expect(page.getByText("Add a subject")).toBeVisible();
    await expect(page.getByText("Write a message body")).toBeVisible();
    await expect(page.getByText("Upload a recipient list")).toBeVisible();
    await expect(page.getByText("Pick a future time")).toBeVisible();

    expect(await countSchedules()).toBe(before);
  });

  test("schedules a campaign and it appears in Scheduled", async ({
    page,
    db,
    seed,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^compose$/i }).first().click();

    await page.getByLabel("Subject").fill("E2E campaign subject");
    await page
      .getByRole("textbox", { name: /email body/i })
      .fill("Hello from the end to end suite.");

    await page.setInputFiles(
      'input[type="file"]',
      fixture(
        "recipients.csv",
        "recipient-one@example.com\nrecipient-two@example.com\nrecipient-three@example.com",
      ),
    );

    // Client-side parse feedback before anything is submitted (FE-CSV-002).
    await expect(page.getByText("3 valid")).toBeVisible();

    await pickFutureDate(page);
    await page.getByLabel("Delay between 2 emails").fill("200");
    await page.getByLabel("Hourly Limit").fill("50");

    await page.getByRole("button", { name: /schedule email/i }).click();

    await expect(page.getByText("Schedule created")).toBeVisible({
      timeout: 25_000,
    });
    await expect(
      page.getByRole("heading", { name: /compose new email/i }),
    ).toBeHidden();

    const { rows: schedules } = await db.query<{ id: string }>(
      "select id from schedules where owner_id = $1 order by created_at desc limit 1",
      [seed.userId],
    );
    const scheduleId = schedules[0]!.id;

    const { rows: recipients } = await db.query<{ status: string }>(
      "select status from recipients where schedule_id = $1",
      [scheduleId],
    );
    expect(recipients).toHaveLength(3);
    for (const r of recipients) {
      expect(["queued", "sending", "sent", "failed"]).toContain(r.status);
    }

    // FE-COMP-006: the Scheduled view reconciles without a hard reload.
    await page.getByRole("tab", { name: /scheduled/i }).click();
    await expect(page.getByText("E2E campaign subject")).toBeVisible({
      timeout: 20_000,
    });
  });

  test("replaying the same idempotency key returns the original schedule", async ({
    request,
    db,
    seed,
  }) => {
    const body = {
      subject: "Idempotency probe",
      body: "<p>x</p>",
      recipients: ["dup-a@example.com"],
      startAt: new Date(Date.now() + 7_200_000).toISOString(),
      delayMs: 0,
      hourlyLimit: 10,
    };
    const key = `e2e-idem-${Date.now()}`;
    const headers = {
      Cookie: `session=${seed.token}`,
      "Idempotency-Key": key,
      "Content-Type": "application/json",
    };

    // BE-API-003: a double submission must not create a second resource.
    const first = await request.post(`${API}/api/v1/schedules`, {
      headers,
      data: body,
    });
    const second = await request.post(`${API}/api/v1/schedules`, {
      headers,
      data: body,
    });

    expect(first.status()).toBe(201);
    expect(second.status()).toBe(200);

    const a = (await first.json()) as { id: string };
    const b = (await second.json()) as { id: string };
    expect(b.id).toBe(a.id);

    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from schedules where owner_id = $1 and idempotency_key = $2",
      [seed.userId, key],
    );
    expect(rows[0]?.n).toBe(1);
  });

  test("duplicate recipients in a CSV collapse deterministically", async ({
    request,
    db,
    seed,
  }) => {
    const res = await request.post(`${API}/api/v1/schedules`, {
      headers: {
        Cookie: `session=${seed.token}`,
        "Content-Type": "application/json",
      },
      data: {
        subject: "Dedupe probe",
        body: "<p>x</p>",
        recipients: [
          "Dup@Example.com",
          "dup@example.com",
          "DUP@example.COM",
          "other@example.com",
        ],
        startAt: new Date(Date.now() + 7_200_000).toISOString(),
        delayMs: 0,
        hourlyLimit: 10,
        idempotencyKey: `e2e-dedupe-${Date.now()}`,
      },
    });

    expect(res.status()).toBe(201);
    const created = (await res.json()) as { id: string };

    const { rows } = await db.query<{ email: string; seq: number }>(
      `select normalized_email as email, sequence_no as seq from recipients
        where schedule_id = $1 order by sequence_no asc`,
      [created.id],
    );

    // BE-DB-002: normalization plus dedupe, order preserved.
    expect(rows.map((r) => r.email)).toEqual([
      "dup@example.com",
      "other@example.com",
    ]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  test("the CSV parser reports valid, invalid and duplicate counts", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^compose$/i }).first().click();

    await page.setInputFiles(
      'input[type="file"]',
      fixture(
        "mixed.csv",
        [
          "good@example.com",
          "not-an-email",
          "also-good@example.com",
          "good@example.com",
        ].join("\n"),
      ),
    );

    await expect(page.getByText("2 valid")).toBeVisible();
    await expect(page.getByText("1 invalid")).toBeVisible();
    await expect(page.getByText(/1 duplicates removed/)).toBeVisible();
  });

  test("pagination is bounded and search is server driven", async ({
    request,
    seed,
  }) => {
    // BE-API-004: unbounded retrieval is impossible.
    const rejected = await request.get(`${API}/api/v1/schedules?limit=100000`, {
      headers: { Cookie: `session=${seed.token}` },
    });
    expect(rejected.status()).toBe(400);

    // Search reads the query string rather than silently defaulting.
    const res = await request.get(
      `${API}/api/v1/schedules?search=Idempotency&limit=5&page=1`,
      { headers: { Cookie: `session=${seed.token}` } },
    );
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      items: { subject: string }[];
      pagination: { limit: number; page: number; total: number };
    };
    expect(body.pagination).toMatchObject({ limit: 5, page: 1 });
    for (const item of body.items) {
      expect(item.subject.toLowerCase()).toContain("idempotency");
    }
  });

  test("a script payload in the body is sanitized before it is stored", async ({
    request,
    db,
    seed,
  }) => {
    // FE-SEC-002: hostile content must not persist as executable markup.
    const res = await request.post(`${API}/api/v1/schedules`, {
      headers: {
        Cookie: `session=${seed.token}`,
        "Content-Type": "application/json",
      },
      data: {
        subject: "Sanitizer probe",
        body:
          '<p>ok</p><script>alert("xss")</script>' +
          '<img src=x onerror="alert(1)">' +
          '<a href="javascript:alert(2)">click</a>',
        recipients: ["xss@example.com"],
        startAt: new Date(Date.now() + 7_200_000).toISOString(),
        delayMs: 0,
        hourlyLimit: 10,
        idempotencyKey: `e2e-xss-${Date.now()}`,
      },
    });
    expect(res.status()).toBe(201);
    const created = (await res.json()) as { id: string };

    const { rows } = await db.query<{ body: string }>(
      "select body from schedules where id = $1",
      [created.id],
    );

    const stored = rows[0]!.body;
    expect(stored).not.toContain("<script");
    expect(stored).not.toContain("onerror");
    expect(stored).not.toContain("javascript:");
  });

  test("the scheduled list shows real recipient addresses, not schedule ids", async ({
    page,
    request,
    seed,
  }) => {
    const API = process.env.E2E_API_URL ?? "http://localhost:3000";
    const stamp = Date.now();

    // Created through the API so the assertion targets rendering, not compose.
    const create = async (subject: string, recipients: string[]) =>
      (
        await request.post(`${API}/api/v1/schedules`, {
          headers: {
            "Content-Type": "application/json",
            Cookie: `session=${seed.token}`,
          },
          data: {
            subject,
            body: "<p>hello</p>",
            recipients,
            startAt: new Date(Date.now() + 7_200_000).toISOString(),
            delayMs: 0,
            hourlyLimit: 10,
            idempotencyKey: `render-${stamp}-${subject}`,
          },
        })
      ).status();

    const solo = "solo-render-check@example.com";
    const many = "first-of-many-render-check@example.com";

    expect(await create("render solo", [solo])).toBe(201);
    expect(
      await create("render many", [many, "second-render-check@example.com"]),
    ).toBe(201);

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const row = page
      .locator("li")
      .filter({ hasText: "render solo" })
      .first();
    await expect(row).toBeVisible();

    // The recipient cell must carry the address a user recognises.
    await expect(row.locator(".list-row-recipient")).toContainText(solo);

    // A multi-recipient campaign shows the first address and an overflow count.
    const manyRow = page
      .locator("li")
      .filter({ hasText: "render many" })
      .first();
    await expect(manyRow.locator(".list-row-recipient")).toContainText(many);
    await expect(manyRow.locator(".list-row-recipient")).toContainText("+1");

    // Regression guard: the old render was an 8-character slice of the uuid.
    const cells = await page.locator(".list-row-recipient").allInnerTexts();
    for (const cell of cells) {
      expect(cell).not.toMatch(/^[0-9a-f]{8}$/i);
    }
  });
});
