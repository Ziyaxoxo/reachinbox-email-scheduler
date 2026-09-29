const {
  RUNTIME_API_URL_PLACEHOLDER,
} = require("./scripts/api-url-placeholder.js");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    /**
     * The proxy target is resolved from `process.env.API_URL` in development,
     * where `next dev` re-reads this file on every server start.
     *
     * A production build cannot do the same. `next build` compiles these
     * rewrites into `.next/routes-manifest.json` and `next start` serves the
     * compiled table without ever re-reading `next.config.js`, so a destination
     * read from the environment here is frozen with whatever the value happened
     * to be during the build. Render only injects environment variables at
     * runtime, so the build emits a placeholder and
     * `scripts/resolve-api-url.mjs` substitutes the real origin on container
     * start, just before `next start`.
     */
    const apiOrigin =
      process.env.NODE_ENV === "development"
        ? process.env.API_URL || "http://localhost:3000"
        : RUNTIME_API_URL_PLACEHOLDER;

    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiOrigin}/api/v1/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
