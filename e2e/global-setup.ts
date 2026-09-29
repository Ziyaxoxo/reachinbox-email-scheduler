import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { FullConfig } from "@playwright/test";
import { seedUser, type SeedResult } from "./scripts/seed.js";

export type { SeedResult };

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_FILE = join(here, "test-results", ".seed.json");

/**
 * Verify both services are reachable before running anything, so a failure
 * reports "services down" rather than a wall of unrelated selector timeouts.
 */
async function assertReachable(name: string, url: string, probe: string) {
  const deadline = Date.now() + 20_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}${probe}`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `${name} is not reachable at ${url}${probe} (${lastError}).\n` +
      `Start the stack first:\n` +
      `  cd reachinbox-backend; $env:SMTP_TRANSPORT="stub"; docker-compose up -d --build\n` +
      `  cd reachinbox-frontend; npm run dev`,
  );
}

export default async function globalSetup(_config: FullConfig) {
  const webUrl = process.env.E2E_WEB_URL ?? "http://localhost:3001";
  const apiUrl = process.env.E2E_API_URL ?? "http://localhost:3000";

  await assertReachable("Frontend", webUrl, "/login");
  await assertReachable("Backend API", apiUrl, "/health/live");

  const seed: SeedResult = await seedUser("e2e");

  mkdirSync(dirname(SEED_FILE), { recursive: true });
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2), "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `\n  E2E seeded\n    user:  ${seed.email}\n    id:    ${seed.userId}\n    token: ${seed.token.slice(0, 24)}…\n`,
  );
}

export function readSeed(): SeedResult {
  if (!existsSync(SEED_FILE)) {
    throw new Error(
      "Seed file missing. Run the suite through Playwright so global-setup executes.",
    );
  }
  return JSON.parse(readFileSync(SEED_FILE, "utf8")) as SeedResult;
}
