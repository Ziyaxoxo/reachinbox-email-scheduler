# ReachInbox E2E suite

End-to-end tests spanning the Express API, the BullMQ workers and the Next.js
dashboard. They drive the real product surfaces — no mocked API, no stubbed auth
middleware — and assert delivery outcomes against the database because sending
is asynchronous and the UI is never the authority.

## What is covered

| Spec | Requirements |
| --- | --- |
| `auth.spec.ts` | FE-AUTH-001..006, BE-SEC-001..002. OAuth start, session verification, cross-owner scoping, id substitution, logout, dashboard auth |
| `compose.spec.ts` | FE-COMP-001..007, FE-CSV-001..003, FE-API-004, FE-SEC-002. Compose, CSV upload with counts, idempotency, dedupe, bounded pagination, server-side sanitization |
| `delivery.spec.ts` | BE-SMTP-004, BE-ES-001..003, BE-RATE-002/004, BE-SLACK-004, BE-PERSIST-002/003, BE-CONC-005. Terminal states, provider ids, outbox to Elasticsearch, deferred-not-dropped, restart recovery without duplicate sends |
| `security.spec.ts` | FE-SEC-002..005, BE-SEC-003..005. Stored XSS does not execute, no secrets in the client bundle, token never in web storage, cookie flags, no recipient data in metrics |
| `slack.spec.ts` | BE-SLACK-003, BE-SLACK-002. Live rate-limit message reaches the channel; status endpoint never leaks a token |

## Related suites

Failure injection and load testing live in the backend because they need the
docker CLI and the stub transport:

```powershell
cd ..\reachinbox-backend

npm run test:failure-injection   # crash boundaries, provider error classification
npm run test:outages            # Elasticsearch / Slack / Redis down
npm run load:test               # 1000+ recipients, bounded memory
npm run test:invariants         # capacity, duplicates, delay across workers
```

See `../reachinbox-backend/README.md` for what each asserts.

## Prerequisites

The suite needs the full stack running, with the workers on the **stub**
transport so nothing is really delivered:

```powershell
# 1. Backend: infrastructure + workers in stub mode
cd ..\reachinbox-backend
$env:SMTP_TRANSPORT = "stub"
$env:WORKER_CONCURRENCY = "5"
docker-compose up -d --build

# 2. Frontend on :3001
cd ..\reachinbox-frontend
npm run dev

# 3. Run the suite
cd ..\e2e
npm test
```

Override the endpoints if your ports differ:

```powershell
$env:E2E_WEB_URL = "http://localhost:3001"
$env:E2E_API_URL = "http://localhost:3000"
npm test
```

## How authentication is handled

There is **no test-only login endpoint and no backdoor**. The seed script
inserts a user row directly and signs an HS256 JWT with the backend's own
`JWT_SECRET`, then installs it as an HttpOnly cookie. The suite therefore
exercises the production auth middleware: cookie parsing, JWT verification and
the owner-scope database lookup. `global-setup` fails with a clear message if
either service is unreachable, so a stack problem never looks like a selector
problem.

## Browser

This environment cannot download Playwright's bundled Chromium, so the project
uses the system Chrome via `channel: "chrome"`. Same engine, already installed.

## Notes

- Tests run with `workers: 1` and `fullyParallel: false`. Worker mutations share
  the per-sender hourly rate-limit window, so parallel files would race and make
  the capacity assertions meaningless.
- `resetSenderRateWindow` clears a sender's Redis rate-limit keys before
  capacity tests, so each starts from a known-empty window.
- The restart-recovery test genuinely stops and starts the worker containers via
  `docker-compose`, so it needs the Docker CLI available and the backend path
  at `C:/Users/FAIHA/OneDrive/Documents/Default Project/reachinbox-backend`
  (see `BACKEND` in `delivery.spec.ts`).
- Traces and screenshots are retained on failure: `test-results/`, with an HTML
  report in `playwright-report/`.

## After the run

Restore the real transport:

```powershell
cd ..\reachinbox-backend
$env:SMTP_TRANSPORT = "ethereal"
docker-compose up -d
```
