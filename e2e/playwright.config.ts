import { defineConfig, devices } from "@playwright/test";

const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3001";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3000";

/**
 * End-to-end configuration.
 *
 * Uses the Chrome channel rather than a downloaded Chromium: this environment
 * cannot fetch Playwright's bundled browser, and the system Chrome exercises the
 * same rendering engine the product ships to.
 */
export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  // Worker mutations are shared state; parallel files would race on the same
  // sender's rate-limit window and make assertions meaningless.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],

  use: {
    baseURL: WEB_URL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 900 },
      },
    },
  ],

  globalSetup: "./global-setup.ts",
  metadata: { webUrl: WEB_URL, apiUrl: API_URL },
});
