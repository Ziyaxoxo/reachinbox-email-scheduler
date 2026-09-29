/**
 * Negative control for the stored-XSS assertion.
 *
 * The E2E test asserts the persisted schedule body contains no executable
 * markup. A test that cannot fail is not evidence, so this runs the same
 * payloads through the sanitizer twice: once normally, and once with the
 * bypass enabled, and confirms the stored value differs.
 *
 * If the bypassed output still looked clean, the E2E assertion would be
 * vacuous.
 */
import { sanitizeEmailBody } from "../src/services/sanitize/html.js";

const PAYLOADS = [
  '<img src=x onerror="window.__xss1=1">',
  "<script>window.__xss2=1</script>",
  '<svg/onload="window.__xss3=1">',
  '<a href="javascript:alert(1)">x</a>',
  '<iframe src="javascript:1"></iframe>',
];

process.env.SECURITY_TEST_NEGATIVE_CONTROL = "0";

let allClean = true;
let allDirtyWithoutGuard = true;

for (const payload of PAYLOADS) {
  const guarded = sanitizeEmailBody(payload).html;

  process.env.SECURITY_TEST_NEGATIVE_CONTROL = "1";
  const bypassed = sanitizeEmailBody(payload).html;
  process.env.SECURITY_TEST_NEGATIVE_CONTROL = "0";

  const dangerous = /<script|onerror|onload|javascript:|onclick|ontoggle|<iframe/i;

  const guardedClean = !dangerous.test(guarded);
  const bypassDirty = dangerous.test(bypassed);

  if (!guardedClean) allClean = false;
  if (!bypassDirty) allDirtyWithoutGuard = false;

  console.log(`payload: ${payload.slice(0, 44)}`);
  console.log(`  guarded : ${guardedClean ? "CLEAN" : "STILL DANGEROUS"}  ${guarded.slice(0, 60)}`);
  console.log(`  bypassed: ${bypassDirty ? "DIRTY (as expected)" : "UNEXPECTEDLY CLEAN"}`);
}

console.log("");
console.log(`sanitizer removes every payload:        ${allClean ? "YES" : "NO"}`);
console.log(
  `stored value WOULD contain markup if bypassed: ${allDirtyWithoutGuard ? "YES" : "NO"}`,
);
console.log(
  `\nRESULT: ${allClean && allDirtyWithoutGuard ? "PASS — the assertion has teeth" : "FAIL — the assertion is vacuous"}`,
);

process.exit(allClean && allDirtyWithoutGuard ? 0 : 1);
