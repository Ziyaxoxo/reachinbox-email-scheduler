/**
 * The role this process resolved at boot, published for the health router.
 *
 * Mode is decided once in `resolveMode()` before anything else runs, and the
 * decision cannot be re-derived reliably later: by the time a request arrives,
 * the observable evidence is ambiguous. A dedicated worker has no HTTP listener,
 * so the only way to ask it anything is over HTTP, which it cannot answer.
 *
 * The startup log is therefore the only place the mode is reported, and reading
 * a log to answer "is this replica consuming?" is a poor substitute for asking
 * the process. This holds the value so `GET /health/mode` can answer it directly.
 *
 * Deliberately not an environment read: the whole failure this covers is a
 * process whose environment says `WORKER_MODE` while its argv or resolution path
 * took a different branch. Re-reading the env would report the intent, not what
 * the process actually did.
 *
 * `servesHttp` is reported alongside `isWorker` because the two are independent.
 * A hybrid process answers this route *and* consumes, so `isWorker` alone would
 * read as a contradiction on a route that plainly responded.
 */
export interface ResolvedMode {
  /** True when this process registered queue consumers. */
  isWorker: boolean;
  /** True when this process serves HTTP. */
  servesHttp: boolean;
  /** Which signal decided it: `argv`, `env`, `embedded`, or `default`. */
  via: string;
}

let resolved: ResolvedMode = { isWorker: false, servesHttp: true, via: "unresolved" };

export function publishMode(mode: ResolvedMode): void {
  resolved = mode;
}

export function getMode(): ResolvedMode {
  return resolved;
}
