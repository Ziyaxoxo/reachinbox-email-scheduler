/**
 * The single source of truth for the API proxy placeholder.
 *
 * Shared by `next.config.js` (which emits it into the build) and
 * `scripts/resolve-api-url.mjs` (which substitutes the real origin at container
 * start) so the two can never drift. A drift here would be a silent production
 * bug: the proxy would forward to a literal placeholder string and every API
 * call would fail.
 */

/**
 * Next.js compiles `rewrites()` into `.next/routes-manifest.json` during
 * `next build`, and `next start` never re-reads `next.config.js`. Any
 * destination derived from `process.env` is therefore frozen at build time.
 *
 * Render injects environment variables at *runtime*, which is after the build,
 * so the build emits this token instead of a host and the container resolves it
 * immediately before the server starts.
 *
 * The token carries a scheme because Next.js validates rewrite destinations
 * during the build and rejects anything that does not start with `/`, `http://`
 * or `https://`. The whole token including the scheme is substituted at
 * container start, so an `http://` API origin resolves correctly too.
 *
 * Keeping it a well-formed absolute URL also means that if the substitution
 * never happened the proxy would fail loudly on DNS rather than quietly
 * forwarding to something plausible.
 */
const RUNTIME_API_URL_PLACEHOLDER = "https://__RUNTIME_API_URL__";

module.exports = { RUNTIME_API_URL_PLACEHOLDER };
