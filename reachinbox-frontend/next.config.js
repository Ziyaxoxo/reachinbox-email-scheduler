/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * No `rewrites()` here on purpose.
   *
   * A rewrite to an external origin looked like the natural way to proxy
   * /api/v1 to the backend, but Next forwards the Authorization header and
   * silently drops Cookie. Cookie-based session auth therefore cannot work
   * through it: the session cookie never reached the API and every
   * authenticated request returned 401.
   *
   * The proxy now lives in src/app/api/v1/[...path]/route.ts, which forwards
   * headers explicitly and reads API_URL per request. That also means the build
   * no longer needs to know the API origin, so there is no build argument and no
   * placeholder to resolve at container start.
   */
};

module.exports = nextConfig;
