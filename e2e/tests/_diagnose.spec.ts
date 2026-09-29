/**
 * Diagnostic: does the compose → schedule flow work when every field is valid?
 * And does the sidebar Sent nav / search actually do anything?
 *
 * Reports rather than asserts, so the output reads as findings.
 */
import { test, expect, authenticate } from "./fixtures.js";

const API = process.env.E2E_API_URL ?? "http://localhost:3000";

async function fillCompose(page: any, subject: string) {
  await page.getByLabel("Subject").fill(subject);
  await page
    .getByRole("textbox", { name: /email body/i })
    .fill("Hello from the diagnosis run.");
}

test.describe("compose diagnosis", () => {
  test("fully valid compose with an explicit future time", async ({
    page,
    seed,
    request,
  }) => {
    await authenticate(page);
    await page.goto("/");
    await page.getByRole("button", { name: /^compose$/i }).first().click();
    await expect(page.getByRole("heading", { name: /compose new email/i })).toBeVisible();

    await fillCompose(page, "diag-valid-future");
    const toField = page.getByLabel("Recipients");
    if (await toField.isEditable()) await toField.fill("diag-valid@example.com");

    await page.getByRole("button", { name: /schedule send time/i }).click();
    await page.getByRole("button", { name: /tomorrow/i }).click();

    await page.getByRole("button", { name: /^schedule email$/i }).click();
    await page.waitForTimeout(2000);

    const errors = await page.locator(".field-error").allInnerTexts();
    const toasts = await page.locator(".toast, [role='status']").allInnerTexts().catch(() => []);

    const res = await request.get(`${API}/api/v1/schedules?limit=50`, {
      headers: { Cookie: `session=${seed.token}` },
    });
    const body = (await res.json()) as { items: Array<{ subject: string }> };
    const found = body.items.map((i) => i.subject);

    console.log("V1 url =", page.url());
    console.log("V1 errors =", JSON.stringify(errors));
    console.log("V1 toasts =", JSON.stringify(toasts));
    console.log("V1 created =", JSON.stringify(found));
    console.log("V1 SUCCESS =", found.includes("diag-valid-future"));
  });

  test("fully valid compose with the DEFAULT (now) time", async ({
    page,
    seed,
    request,
  }) => {
    await authenticate(page);
    await page.goto("/");
    await page.getByRole("button", { name: /^compose$/i }).first().click();
    await expect(page.getByRole("heading", { name: /compose new email/i })).toBeVisible();

    await fillCompose(page, "diag-default-time");
    const toField = page.getByLabel("Recipients");
    if (await toField.isEditable()) await toField.fill("diag-default@example.com");

    await page.getByRole("button", { name: /^schedule email$/i }).click();
    await page.waitForTimeout(2000);

    const errors = await page.locator(".field-error").allInnerTexts();
    const res = await request.get(`${API}/api/v1/schedules?limit=50`, {
      headers: { Cookie: `session=${seed.token}` },
    });
    const body = (await res.json()) as { items: Array<{ subject: string }> };
    const found = body.items.map((i) => i.subject);

    // Is the error even visible without scrolling?
    const errEl = page.locator(".field-error", { hasText: "Pick a future time" });
    const errCount = await errEl.count();
    let errVisible = false;
    if (errCount > 0) errVisible = await errEl.first().isVisible();

    console.log("V2 errors =", JSON.stringify(errors));
    console.log("V2 'Pick a future time' visible without scrolling =", errVisible);
    console.log("V2 created =", JSON.stringify(found));
  });

  test("sidebar Sent nav vs local tab state", async ({ page }) => {
    await authenticate(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: /^compose$/i }).first()).toBeVisible();

    const scheduledTab = page.getByRole("tab", { name: "scheduled" });
    const sentTab = page.getByRole("tab", { name: "sent" });
    console.log("V3 selected before =", await scheduledTab.getAttribute("aria-selected"),
      await sentTab.getAttribute("aria-selected"));

    await page.getByRole("button", { name: /^sent/i }).click();
    await page.waitForTimeout(900);

    console.log("V3 url =", page.url());
    console.log("V3 selected after =", await scheduledTab.getAttribute("aria-selected"),
      await sentTab.getAttribute("aria-selected"));
    console.log("V3 aria-current =", JSON.stringify(await page.locator("[aria-current='page']").allInnerTexts()));
  });

  test("search baseline and clear affordance", async ({ page }) => {
    await authenticate(page);
    await page.goto("/");
    await expect(page.getByRole("searchbox", { name: /search emails/i })).toBeVisible();
    await page.waitForTimeout(1000);

    const before = await page.locator(".list-row").count();
    console.log("V4 rows before search =", before);

    const search = page.getByRole("searchbox", { name: /search emails/i });
    await search.fill("zzzz-no-match");
    await page.waitForTimeout(900);
    console.log("V4 rows after nonsense search =", await page.locator(".list-row").count());

    await search.fill("");
    await page.waitForTimeout(900);
    console.log("V4 rows after clearing search =", await page.locator(".list-row").count());

    // What clear affordances exist?
    const nativeClear = page.locator('input[type="search"]::-webkit-search-cancel-button');
    console.log("V4 filter button count =", await page.getByRole("button", { name: /^filter$/i }).count());
    console.log("V4 refresh button count =", await page.getByRole("button", { name: /^refresh$/i }).count());

    // Does the Refresh button refresh, or do something else?
    const before2 = await page.locator('[aria-current="page"]').allInnerTexts();
    await page.getByRole("button", { name: /^refresh$/i }).click();
    await page.waitForTimeout(700);
    const after2 = await page.locator('[aria-current="page"]').allInnerTexts();
    console.log("V4 refresh button — before active =", JSON.stringify(before2));
    console.log("V4 refresh button — after active  =", JSON.stringify(after2));
  });
});
