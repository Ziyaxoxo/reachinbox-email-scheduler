# Next.js 14.2.35: Security Advisory Posture

The application runs Next.js 14.2.35 (frontend), which appears in recent advisories. This document records which advisories actually apply to this codebase, the risk assessment, and the planned upgrade path.

## App surface area (what is actually used)

- **Framework**: Next.js 14 App Router (not Pages Router). No custom server.
- **Image optimization**: No `next/image` usage anywhere in `src/`. No `remotePatterns`, no custom image loader.
- **Middleware**: No `middleware.ts` or `middleware.js` present.
- **Server Actions**: None (`"use server"` not present).
- **Rewrites/redirects**: None configured in `next.config.mjs` (rewrites were removed in favor of the `/api/v1/[...path]` route handler).
- **Route handlers (edge/SSR)**: Only `src/app/api/v1/[...path]/route.ts`, which acts as a reverse proxy to the backend. It forwards request bodies and headers (stripping hop-by-hop), does not deserialize arbitrary JSON structures from user input in a way that would be exploitable via the specific RCE/DoS vectors in the advisories.
- **External imports of untrusted scripts**: No `dangerouslySetInnerHTML`, no dynamic script injection. No `next/script` loading untrusted code.
- **i18n**: Not configured. App Router app, no Pages i18n routing.
- **Authentication**: Cookie-based sessions (HttpOnly), proxied to backend. No OAuth token handling in Next middleware.

## Applicability by category (high-level)

| Advisory class | Applies here? | Rationale |
|---|---|---|
| Image Optimizer (`next/image`) DoS/RCE | No | App never uses `next/image`. |
| Middleware cache poisoning/bypass | No | No middleware. |
| Server Actions DoS | No | No Server Actions. |
| Rewrites/request smuggling/poisoning | No | No `rewrites()` in config. |
| Pages Router i18n bypass | No | App Router, no i18n. |
| WebSocket upgrades SSRF | No | No WebSocket upgrades via Next. |
| RSC cache collision/poisoning | Low/Not exposed | App uses App Router but has minimal server component data fetching and no complex RSC caching patterns that would make the known collision cases exploitable. The attack surface is constrained. |
| CSP nonce XSS | No | No CSP nonce usage in a vulnerable pattern. |
| `beforeInteractive` script XSS | No | No untrusted `beforeInteractive` scripts. |

Most "critical/high" Next.js advisories target specific features (Image Optimizer, Middleware, Server Actions, certain rewrite configurations). This app does not use those features, so the direct exploit paths do not exist in production.

## Known risks (residual)

- **Transitive dependencies**: Some advisories affect any Next 14.x in that range; even unused code paths may be present. However, the practical impact depends on deployment configuration (self-hosted vs Vercel) and which subsystems are enabled.
- **Future code changes**: Adding `next/image`, middleware, or Server Actions would re-open several of these classes without upgrading.
- **Self-hosted runtime**: The app is deployed on Render (Node). Image optimization is not invoked at all.

## Recommended approach

**Do not upgrade now (pre-demo).** The upgrade from Next 14.2.35 → 16.3.7 is non-trivial:

1. React 18.3.1 → React 19 (peer dependency change; many packages may need updates)
2. Next 14 → 16 App Router breaking changes (caching, async Request APIs, bundler/config shifts)
3. Build + all 37 frontend tests must pass
4. End-to-end suite (43 checks locally) must re-validate
5. Risk of introducing a regression immediately before recording the demo

**Plan for post-demo upgrade:**

1. Create a dedicated branch `chore/next-16-upgrade`
2. Bump `next` to `^16.3.7`, `react`/`react-dom` to `^19.x` per Next's upgrade guide
3. Address breaking changes (route handlers, caching semantics, Turbopack compatibility)
4. Run full unit + typecheck + build + e2e (local)
5. Deploy to a preview/staging Render service before production
6. Re-run the live verification harness (`verify-live.mjs`) against staging

## Decision log

- **2026-09-30**: Assessed advisories against actual usage. Determined most critical paths are not exposed.
- **Decision**: Document posture, defer upgrade to after demo recording (trading a theoretical CVE exposure for demo stability). This matches the earlier explicit choice to avoid the upgrade before grading/demo.
- **Tracking**: Revisit after recording/demo sign-off.

## Verification artifacts

- `reachinbox-frontend/package.json`: `next@^14.2.21` (installed 14.2.35), `react@^18.3.1`
- No `next/image`, no `middleware.*`, no Server Actions found via grep
- `next.config.mjs`: no `rewrites`, `images`, `remotePatterns`, or experimental flags
- Frontend lint/typecheck/tests/build: all green
