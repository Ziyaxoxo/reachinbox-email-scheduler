export const WINDOW_SECONDS = 3600;

/**
 * Aligned hourly window helpers.
 *
 * Buckets are aligned to the UTC hour boundary so every worker instance and
 * every process restart agrees on which window is current. A rolling window
 * keyed on first-send would let capacity leak across boundaries and make
 * "reschedule to the next available window" ambiguous.
 */

export function currentWindowStart(now: number = Date.now()): number {
  return Math.floor(now / (WINDOW_SECONDS * 1000)) * WINDOW_SECONDS * 1000;
}

export function nextWindowStart(windowStartMs: number): number {
  return windowStartMs + WINDOW_SECONDS * 1000;
}

export function windowKeyFor(senderId: string, windowStartMs: number): string {
  return `rate_limit:${senderId}:hourly:${windowStartMs}`;
}
