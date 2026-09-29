import { test, expect, WEB_URL, API_URL, authenticate } from "./fixtures.js";

/**
 * FE-AUTH-001..006 and BE-SEC-001..002 — authentication and authorization.
 *
 * The suite never mocks the session: a real HS256 token signed with the
 * backend's JWT_SECRET is installed as an HttpOnly cookie, so the production
 * auth middleware is what is under test.
 */
test.describe("authentication", () => {
  test("login page renders the Google OAuth call to action", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Login" })).toBeVisible();

    const cta = page.getByRole("link", { name: /login with google/i });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/api/v1/auth/google");
  });

  test("OAuth start redirects to Google with the expected parameters", async ({
    page,
  }) => {
    await page.goto("/login");

    const [request] = await Promise.all([
      page.waitForRequest((r) =>
        r.url().includes("accounts.google.com/o/oauth2/v2/auth"),
      ),
      page.getByRole("link", { name: /login with google/i }).click(),
    ]);

    const url = new URL(request.url());
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("scope")).toContain("email");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${API_URL}/api/v1/auth/google/callback`,
    );
  });

  test("unauthenticated API access is rejected with 401", async ({ request }) => {
    const res = await request.get(`${API_URL}/api/v1/me`);
    expect(res.status()).toBe(401);
  });

  test("a forged or tampered token is rejected", async ({ request }) => {
    const res = await request.get(`${API_URL}/api/v1/me`, {
      headers: { Cookie: "session=not.a.valid.jwt" },
    });
    expect(res.status()).toBe(401);
  });

  test("dashboard shows the authenticated profile from the API", async ({
    page,
    seed,
  }) => {
    await authenticate(page);
    await page.goto("/");

    await expect(
      page.getByRole("searchbox", { name: /search emails/i }),
    ).toBeVisible();
    await expect(page.getByText(seed.name).first()).toBeVisible();
    await expect(page.getByText(seed.email).first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: /mailbox/i })).toBeVisible();
  });

  test("the BullMQ dashboard is not reachable without an operator token", async ({
    request,
  }) => {
    const res = await request.get(`${API_URL}/admin/queues`);
    expect(res.status()).toBe(401);
  });

  test("cross-owner scoping is enforced by the API, not the UI", async ({
    request,
    seed,
  }) => {
    const { seedUser } = await import("../scripts/seed.js");
    const other = await seedUser("e2e-other");

    const res = await request.get(`${API_URL}/api/v1/schedules`, {
      headers: { Cookie: `session=${other.token}` },
    });
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      items: { ownerId: string }[];
    };

    // FE-AUTH-006 / BE-SEC-001: another owner's records are never returned,
    // regardless of what the client displays.
    for (const item of body.items) {
      expect(item.ownerId).toBe(other.userId);
      expect(item.ownerId).not.toBe(seed.userId);
    }
  });

  test("substituting another owner's schedule id is denied", async ({
    request,
    db,
    seed,
  }) => {
    // Create a schedule as the seeded owner.
    const created = await request.post(`${API_URL}/api/v1/schedules`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: `session=${seed.token}`,
      },
      data: {
        subject: "Owned by the other user",
        body: "<p>secret</p>",
        recipients: ["victim@example.com"],
        startAt: new Date(Date.now() + 7_200_000).toISOString(),
        delayMs: 0,
        hourlyLimit: 10,
        idempotencyKey: `e2e-owned-${Date.now()}`,
      },
    });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // A different owner must not be able to read it by guessing the id.
    const { seedUser } = await import("../scripts/seed.js");
    const attacker = await seedUser("e2e-attacker");

    const res = await request.get(`${API_URL}/api/v1/schedules/${id}`, {
      headers: { Cookie: `session=${attacker.token}` },
    });
    expect([403, 404]).toContain(res.status());

    void db;
  });

  test("logout clears the session and the API stops accepting it", async ({
    page,
  }) => {
    await authenticate(page);
    await page.goto("/");

    // Open the profile menu in the sidebar and sign out.
    await page.getByRole("button", { name: /E2E Operator/i }).click();
    await page.getByRole("button", { name: /sign out/i }).click();

    await expect(page.getByRole("heading", { name: "Login" })).toBeVisible({
      timeout: 20_000,
    });

    // The session cookie is gone, so a protected route is 401 again.
    const res = await page.request.get(`${API_URL}/api/v1/me`);
    expect(res.status()).toBe(401);

    void WEB_URL;
  });
});
