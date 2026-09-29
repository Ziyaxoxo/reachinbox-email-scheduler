#!/usr/bin/env node
/**
 * Point the built rewrite proxy at the API origin available at runtime.
 *
 * Runs immediately before `next start` (see the `start` script). See
 * `api-url-placeholder.js` for why the build cannot resolve the origin itself.
 *
 * Safe to run repeatedly: once the placeholder is gone there is nothing to do,
 * so a container restart is a no-op rather than a double substitution.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const { RUNTIME_API_URL_PLACEHOLDER } = require("./api-url-placeholder.js");

const NEXT_DIR = join(here, "..", ".next");

/** Build caches are disposable and huge; they never need patching. */
const SKIP_DIRS = new Set(["cache"]);

function collectJsonFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectJsonFiles(full));
    } else if (entry.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Normalise and sanity-check the origin.
 *
 * A value that is not absolute http(s) would be written into the routing table
 * and then fail per request, far from the cause, so it is rejected here where
 * the stack trace is still useful.
 */
function resolveApiUrl(raw) {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) {
    throw new Error(
      "API_URL is not set. The frontend proxies /api/v1/* to API_URL, so it " +
        "cannot start without it.",
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `API_URL is not a valid absolute URL: ${JSON.stringify(value)}. ` +
        'Expected something like "https://reachinbox-api-vxyo.onrender.com".',
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`API_URL must use http or https, got ${parsed.protocol}`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error("API_URL must be a bare origin with no query string or fragment");
  }
  return value;
}

function main() {
  if (!existsSync(NEXT_DIR)) {
    // `next dev` has no .next build output. Nothing to resolve.
    console.log("[resolve-api-url] no .next build found, nothing to do");
    return;
  }

  const targets = collectJsonFiles(NEXT_DIR).filter((file) => {
    try {
      return readFileSync(file, "utf8").includes(RUNTIME_API_URL_PLACEHOLDER);
    } catch {
      return false;
    }
  });

  if (targets.length === 0) {
    console.log("[resolve-api-url] build already resolved, nothing to do");
    return;
  }

  const apiUrl = resolveApiUrl(process.env.API_URL);

  for (const file of targets) {
    const before = readFileSync(file, "utf8");
    // Every occurrence in these files is the rewrite destination, because the
    // placeholder is a token that exists nowhere else in the build.
    const after = before.split(RUNTIME_API_URL_PLACEHOLDER).join(apiUrl);
    writeFileSync(file, after);
    console.log(
      `[resolve-api-url] ${file.replace(NEXT_DIR, ".next")}: proxy -> ${apiUrl}`,
    );
  }

  console.log(`[resolve-api-url] patched ${targets.length} file(s)`);
}

try {
  main();
} catch (error) {
  console.error(`[resolve-api-url] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
