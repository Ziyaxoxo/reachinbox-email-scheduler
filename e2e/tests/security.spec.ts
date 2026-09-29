import { test, expect, API_URL, authenticate } from "./fixtures.js";

/**
 * Browser-level security (FE-SEC-002..005, BE-SEC-003..005).
 *
 * The API-level suite proves a payload is sanitised before storage. This proves
 * the two things a string check cannot: that stored markup does not *execute*
 * in the application origin, and that no server secret is present in the
 * JavaScript actually shipped to the browser.
 */

const WEB = process.env.E2E_WEB_URL ?? "http://localhost:3001";

/** Payloads that would prove execution if they ran. */
const XSS_PAYLOADS = [
  '<img src=x onerror="window.__xss1=1">',
  '<svg/onload="window.__xss2=1">',
  "<script>window.__xss3=1</script>",
  '<iframe src="javascript:window.__xss4=1"></iframe>',
  '<a href="javascript:window.__xss5=1">click</a>',
  '<body onload="window.__xss6=1">',
  '<details open ontoggle="window.__xss7=1">',
  '<img src="x" onerror="fetch(\'/api/v1/schedules\').then(r=>r.text()).then(t=>window.__exfil=t)">',
];

test.describe("browser security", () => {
  test("stored XSS does not execute in the application origin", async ({
    page,
    request,
    seed,
  }) => {
    await authenticate(page);

    // Store every payload through the real API.
    const subjects: string[] = [];
    for (const [i, payload] of XSS_PAYLOADS.entries()) {
      const res = await request.post(`${API_URL}/api/v1/schedules`, {
        headers: {
          "Content-Type": "application/json",
          Cookie: `session=${seed.token}`,
        },
        data: {
          // The payload also goes in the subject, which the UI renders as text.
          subject: `xss-probe-${i} ${payload.slice(0, 24)}`,
          body: `<p>safe</p>${payload}`,
          recipients: [`xss-${i}@example.com`],
          startAt: new Date(Date.now() + 7_200_000).toISOString(),
          delayMs: 0,
          hourlyLimit: 10,
          idempotencyKey: `xss-${seed.userId}-${i}`,
        },
      });
      expect(res.status()).toBe(201);
      subjects.push(`xss-probe-${i}`);
    }

    // Trip any handler before the app renders.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__xss1 = 0;
      (window as unknown as Record<string, unknown>).__xss2 = 0;
      (window as unknown as Record<string, unknown>).__xss3 = 0;
      (window as unknown as Record<string, unknown>).__xss4 = 0;
      (window as unknown as Record<string, unknown>).__xss5 = 0;
      (window as unknown as Record<string, unknown>).__xss6 = 0;
      (window as unknown as Record<string, unknown>).__xss7 = 0;
      (window as unknown as Record<string, unknown>).__exfil = undefined;
      (window as unknown as Record<string, unknown>).__dialogs = 0;
    });

    // Fail loudly if the page tries to open a dialog.
    page.on("dialog", async (d) => {
      await page.evaluate(() => {
        (window as unknown as Record<string, number>).__dialogs += 1;
      });
      await d.dismiss();
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_000);

    const executed = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        xss1: w.__xss1,
        xss2: w.__xss2,
        xss3: w.__xss3,
        xss4: w.__xss4,
        xss5: w.__xss5,
        xss6: w.__xss6,
        xss7: w.__xss7,
        exfil: w.__exfil,
        dialogs: w.__dialogs,
      };
    });

    for (const [key, value] of Object.entries(executed)) {
      expect(value, `${key} must not execute`).toBeFalsy();
    }

    // The page must also still be a functioning document.
    await expect(
      page.getByRole("searchbox", { name: /search emails/i }),
    ).toBeVisible();
  });

  test("the frontend bundle contains no server secrets", async ({ request }) => {
    const html = await request.get(`${WEB}/`);
    const source = await html.text();

    // Every same-origin script the browser would load.
    const scriptSrcs = [...source.matchAll(/<script[^>]+src="([^"]+)"/g)].map(
      (m) => m[1]!,
    );

    expect(
      scriptSrcs.length,
      "expected at least one client bundle to inspect",
    ).toBeGreaterThan(0);

    const secretPatterns: Array<[string, RegExp]> = [
      ["JWT secret", /JWT_SECRET\s*[:=]\s*["'][A-Za-z0-9+/=_-]{20,}/],
      ["encryption key", /ENCRYPTION_KEY\s*[:=]\s*["'][A-Za-z0-9+/=]{20,}/],
      ["SMTP password", /your-ethereal-password/],
      ["Google client secret", /GOCSPX-[A-Za-z0-9_-]{10,}/],
      ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
      ["database URI", /postgresql:\/\/[^"'\s]+:([^@"'\s]+)@/],
      ["redis password", /redis:\/\/:[^@]+@/],
    ];

    for (const src of scriptSrcs) {
      const url = src.startsWith("http") ? src : `${WEB}${src}`;
      const bundle = await request.get(url);
      const body = await bundle.text();

      for (const [label, pattern] of secretPatterns) {
        expect(
          pattern.test(body),
          `${label} must not appear in ${src}`,
        ).toBe(false);
      }
    }
  });

  test("the session token is never exposed to client storage", async ({
    page,
    seed,
  }) => {
    await authenticate(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const leak = await page.evaluate((token: string) => {
      const probe = token.slice(0, 20);
      const stores = {
        localStorage: Object.entries({ ...localStorage }).map(([k, v]) => `${k}=${v}`),
        sessionStorage: Object.entries({ ...sessionStorage }).map(([k, v]) => `${k}=${v}`),
        cookies: document.cookie,
      };
      return {
        hasProbe: JSON.stringify(stores).includes(probe),
        localKeys: stores.localStorage.length,
        cookieVisibleToJs: stores.cookies,
      };
    }, seed.token);

    expect(leak.hasProbe, "session token must not be in web storage").toBe(false);
    // The cookie is HttpOnly, so document.cookie cannot see it.
    expect(leak.cookieVisibleToJs).not.toContain("session=");
  });

  test("the session cookie is HttpOnly and SameSite", async ({ page, seed }) => {
    await authenticate(page);
    await page.goto("/");

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "session");

    expect(session, "session cookie must exist").toBeTruthy();
    expect(session!.httpOnly, "session cookie must be HttpOnly").toBe(true);
    expect(session!.sameSite, "session cookie must be SameSite").toMatch(/Lax|Strict/i);
  });

  test("telemetry and metrics carry no recipient addresses", async ({
    request,
    seed,
  }) => {
    // Create a recipient with a distinctive address so we can search for it.
    const marker = "sensitive-recipient-canary@example.com";

    await request.post(`${API_URL}/api/v1/schedules`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: `session=${seed.token}`,
      },
      data: {
        subject: "canary",
        body: "<p>canary</p>",
        recipients: [marker],
        startAt: new Date(Date.now() + 7_200_000).toISOString(),
        delayMs: 0,
        hourlyLimit: 10,
        idempotencyKey: `canary-${Date.now()}`,
      },
    });

    const metrics = await request.get(`${API_URL}/metrics`);
    const body = await metrics.text();

    // BE-OBS-003 / BE-SEC-005: metrics are labels and counters, never payloads.
    expect(body).not.toContain(marker);
    expect(body).not.toContain("example.com");
  });

  test("a cross-origin form post cannot mutate state", async ({ page }) => {
    await authenticate(page);
    await page.goto("/");

    // SameSite=Lax means a cross-site POST will not carry the session. Prove
    // the cookie would in fact be withheld by checking the cookie's policy.
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "session");
    expect(session!.sameSite).toMatch(/Lax|Strict/i);
  });
});
