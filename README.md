# ReachInbox — Email Scheduler

Bulk email scheduling with durable delivery guarantees: delayed sends, per-sender
rate limiting, crash recovery, and a transactional outbox for Elasticsearch and
Slack notifications.

| | |
|---|---|
| **Backend** | Express + TypeScript, PostgreSQL, Drizzle ORM, BullMQ/Redis |
| **Frontend** | Next.js + React + TypeScript + Tailwind, React Query |
| **Auth** | Google OAuth, HttpOnly session cookie (HS256 JWT) |
| **Default ports** | API `3000`, web `3001`, PostgreSQL `5432`, Redis `6379`, ES `9200` |

---

## 1. Running the backend

### Option A — Docker Compose (recommended)

This starts every dependency **and** both application processes:

```powershell
cd reachinbox-backend
docker-compose up -d --build
```

| Service | Purpose |
|---|---|
| `postgres` | Source of truth for schedules, recipients, attempts, outbox |
| `redis` | BullMQ queues, rate-limit counters, locks |
| `elasticsearch` | Search index (derived state — never blocks startup) |
| `api` | Express HTTP server on `:3000` |
| `worker` ×2 | BullMQ consumers (send worker + outbox worker) |

Workers are **not** API replicas. `docker-compose.yml` launches them with:

```yaml
command: ["node", "dist/index.js", "--worker"]
environment:
  - WORKER_MODE=1        # workers serve no HTTP, so the healthcheck must not curl
  - WORKER_CONCURRENCY=5
```

`index.ts` only dynamically imports the workers under `--worker`, so adding API
replicas never silently multiplies your send concurrency.

### Option B — Local dev server

Useful when you want hot reload against containers:

```powershell
cd reachinbox-backend
docker-compose up -d postgres redis elasticsearch   # deps only
npm install
npm run dev                                          # tsx watch src/index.ts
```

### Verify it's alive

```powershell
Invoke-WebRequest http://localhost:3000/health/live
Invoke-WebRequest http://localhost:3000/health/ready
```

BullMQ dashboard (authenticated, read-only by default):

```
http://localhost:3000/admin/queues?token=<DASHBOARD_TOKEN>
```

### Useful backend scripts

```powershell
npm run typecheck        # tsc --noEmit
npm run test             # unit + concurrency tests against real Redis/Postgres
npm run db:migrate       # apply Drizzle migrations
npm run db:studio        # Drizzle Studio
npm run build            # tsc -p tsconfig.build.json
```

---

## 2. Running the frontend

```powershell
cd reachinbox-frontend
npm install
npm run dev               # Next.js on http://localhost:3001
```

Open **http://localhost:3001**.

The frontend needs the backend API reachable, and that's it. `next.config.js`
proxies `/api/v1/*` to the backend:

```js
destination: `${process.env.API_URL || "http://localhost:3000"}/api/v1/:path*`
```

So `API_URL` only needs setting if the API is not on `localhost:3000`.

```powershell
# reachinbox-frontend/.env.local  (only if the API is elsewhere)
API_URL=http://localhost:3000
```

> `reachinbox-frontend/.env.example` lists `NEXTAUTH_*` and `GOOGLE_*` values.
> They are **not used** — OAuth runs entirely on the backend and the frontend
> reads no `process.env` values besides the `API_URL` above. Safe to ignore.

### Useful frontend scripts

```powershell
npm run typecheck
npm test            # vitest unit tests
npm run build
```

---

## 3. Ethereal Email + environment variables

Ethereal is a free, **fake** SMTP service for testing. It accepts mail and shows
it in a web inbox — it does **not** deliver to real inboxes. Perfect for
development; swap in SES/Postmark/Resend for production.

### Get credentials

1. Sign up at **https://ethereal.email** (no card required)
2. Create an account under *Accounts* → *Create new account*
3. Copy the **SMTP username** and **password** Ethereal generates

### Generate your secrets

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Required variables

`src/config/env.ts` validates these at boot and exits with a clear message if
any are missing.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | e.g. `postgresql://reachinbox:reachinbox@localhost:5432/reachinbox` |
| `REDIS_URL` | ✅ | e.g. `redis://:reachinbox@localhost:6379/0` |
| `ELASTICSEARCH_URL` | ✅ | e.g. `http://localhost:9200` |
| `GOOGLE_CLIENT_ID` | ✅ | Google Cloud console → OAuth credentials |
| `GOOGLE_CLIENT_SECRET` | ✅ | Redirect URI: `http://localhost:3000/api/v1/auth/google/callback` |
| `GOOGLE_CALLBACK_URL` | ✅ | Same as above |
| `SLACK_CLIENT_ID` | ✅ | https://api.slack.com/apps → OAuth & Permissions |
| `SLACK_CLIENT_SECRET` | ✅ | Scopes: `chat:write`, `channels:read` |
| `JWT_SECRET` | ✅ | ≥ 32 chars — signs session cookies |
| `ENCRYPTION_KEY` | ✅ | 32-byte base64 — encrypts stored Slack tokens |
| `SMTP_USER` / `SMTP_PASS` | ⚠️ | **Your Ethereal address + password** |
| `SMTP_HOST` / `SMTP_PORT` | – | Defaults `smtp.ethereal.email` / `587` |
| `DASHBOARD_TOKEN` | – | Empty **disables** the BullMQ dashboard (fails closed) |
| `DASHBOARD_READ_ONLY` | – | Defaults `true` — mutating HTTP methods are refused |
| `WORKER_CONCURRENCY` | – | Defaults `5` |
| `SMTP_TRANSPORT` | – | `ethereal` (default) or `stub` for test runs |
| `API_RATE_LIMIT_MAX` | – | Defaults `100` requests / `60000` ms |

### Where they go

```powershell
cp reachinbox-backend/.env.example reachinbox-backend/.env
# then edit reachinbox-backend/.env with real values
```

`.env` is **gitignored** in every subproject — verified against the committed
file list, which contains only `.env.example` templates. Rotate your secrets if
they are ever pasted anywhere else.

> ⚠️ Rotating `ENCRYPTION_KEY` invalidates any Slack token already stored,
> because they are encrypted with the previous key. Reconnect Slack after a
> rotation.

---

## 4. Architecture overview

```
                     ┌─────────────────────────────────────────┐
  Browser ──────────▶│  Next.js :3001  (login, dashboard,      │
                     │                 compose, tables)         │
                     └────────────────┬────────────────────────┘
                                      │ rewrites /api/v1/*  (API_URL)
                                      ▼
                     ┌─────────────────────────────────────────┐
                     │  Express :3000                          │
                     │  auth · schedules · emails · slack      │
                     │  └─ scheduler.ts  (one transaction)     │
                     └───────┬───────────────────────┬─────────┘
                             │ writes                │ enqueues (after commit)
                             ▼                       ▼
                    ┌──────────────────┐    ┌──────────────────────────┐
                    │   PostgreSQL     │    │  Redis / BullMQ          │
                    │  source of truth │    │  delayed jobs, counters, │
                    │  schedules       │    │  Lua rate-limit scripts  │
                    │  recipients      │    └───────────┬──────────────┘
                    │  deliveryAttempts│                │
                    │  outboxEvents ───┼────────────────┤
                    └──────────────────┘                ▼
                                              ┌──────────────────────────┐
                                              │  Worker  (--worker)      │
                                              │  emailWorker   ──▶ SMTP  │
                                              │  outboxWorker  ──▶ ES    │
                                              │                ──▶ Slack │
                                              └──────────────────────────┘
```

**Core principle: PostgreSQL is the source of truth; queues are a wake-up
mechanism.** Anything a queue might lose is recoverable by re-reading the
database.

### Process modes

| Mode | Started by | Does |
|---|---|---|
| **API** | `docker-compose up` / `npm run dev` | HTTP only. Runs `reconcilePendingWork()` on boot and every 60 s. |
| **Worker** | `node dist/index.js --worker` | Consumes `email-scheduling` and `outbox-events`. Samples queue depth every 15 s, sweeps retention every 6 h. Serves no HTTP. |

---

## 5. How scheduling works

```
POST /api/v1/schedules
        │
        ▼
  ┌──────────────────── ONE TRANSACTION ────────────────────┐
  │ 1. resolve idempotency key (ownerId, idempotencyKey)    │
  │ 2. INSERT schedules                                     │
  │ 3. INSERT recipients  status = 'queued'  ← status set   │
  │ 4. INSERT outbox_events (one per recipient)             │
  └─────────────────────────────────────────────────────────┘
        │ commit
        ▼
  enqueue BullMQ delayed job   jobId = recipient-<uuid>-1
        │
        ▼  (after startAt + delayMs)
  emailWorker:  CAS claim  ──▶  SMTP  ──▶  attempt row  ──▶  terminal status
```

**Per-recipient jobs, not per-schedule.** Each recipient is its own BullMQ job
keyed by `recipient-<uuid>-<attempt>`. A 1 000-recipient campaign is 1 000
independently retried, independently rate-limited jobs.

Key decisions and why they matter:

| Decision | Why |
|---|---|
| Recipients written as `queued`, not `scheduled` | The worker's claim CAS matches `status = 'queued'`. Writing `scheduled` would make the CAS never succeed. |
| Job lookup by **recipient UUID** | The queue payload carries `recipientId`; the worker does `eq(recipients.id, recipientId)`. A `scheduleId:index` composite key matches nothing. |
| Dashes in job IDs | BullMQ **rejects** single-colon custom job IDs, silently dropping them. `recipient-{uuid}-1` is safe; `outbox:x` is not. |
| Scheduler replays on unique violation | Two concurrent requests with the same idempotency key: the loser catches the `(ownerId, idempotencyKey)` violation and returns the winner's record. |
| Worker functions imported only under `--worker` | A static import would make every API replica a send worker, scaling concurrency with pod count. |

### Idempotency

The client sends an `Idempotency-Key` header (or `idempotencyKey` body field).
It is scoped to the owner via a unique index on `(owner_id, idempotency_key)`,
so the same key replayed returns the original schedule instead of creating a
duplicate.

The compose screen holds this key in a `useRef`, regenerating it **only** when
the modal opens or after a successful submit — so a network retry reuses the
same key rather than minting a new one.

---

## 6. How persistence on restart is handled

Nothing is trusted to survive in Redis. On every boot the API re-reads the
authoritative database:

```ts
await reconcilePendingWork();          // on boot
setInterval(reconcilePendingWork, 60_000);
```

`reconciliation.ts` handles three categories:

| Category | Source | Action |
|---|---|---|
| Never-queued work | `status IN ('scheduled','queued')` | Re-publish idempotently |
| Crashed mid-send | `status = 'sending'` + expired lease | Drop claim → back to `queued` → re-publish |
| Already finished | `sent` / `failed` / `cancelled` | **Never requeued** |

Terminal states are excluded from both scans, so a restart can never duplicate
a send. Re-publishing is idempotent: an already-active BullMQ job with that ID
is left alone rather than clobbered.

### Claim / lease

The worker claims a recipient with a compare-and-swap:

```sql
UPDATE recipients SET status='sending', claimed_by=$1, claim_expires_at=$2
WHERE id=$3 AND (status='queued' OR (status='sending' AND claim_expires_at < now()))
```

Two consequences:

- **Crash safety** — a worker that dies leaves an expired lease another worker
  adopts. No send is stranded and none is lost.
- **At-most-once at the boundary** — if the process dies *after* provider
  acceptance but *before* the status update, recovery checks for an existing
  attempt row with a provider ID and does **not** call SMTP again.

### Transactional outbox

Side effects that must not be lost (Elasticsearch indexing, Slack
notifications) are written as `outbox_events` rows in the **same transaction**
as the state change, then dispatched by a dedicated worker:

```
write state + outbox_events  ──commit──▶  outboxWorker
                                              │ claim  pending → processing
                                              ├─▶ indexEmailRecord
                                              ├─▶ sendSlackRateLimitEvent
                                              └─▶ completed   (or retry, max 5)
```

`indexEmailRecord` and `sendSlackRateLimitEvent` are imported **only** by the
outbox worker — never by the send worker — so the pattern stays honest.

Outage behaviour: Elasticsearch and Slack failures degrade to a pending outbox
row and are retried. They never block or fail an email send.

---

## 7. How rate limiting & concurrency are implemented

### Hourly cap — Redis Lua, atomic

A campaign's `hourlyLimit` is enforced by a Lua script that reserves a slot and
checks the cap in a single atomic step — no read-modify-write race:

```lua
key = rate_limit:{senderId}:hourly:{windowStart}
```

Windows are **aligned to the UTC hour boundary**:

```ts
Math.floor(now / 3600_000) * 3600_000
```

A rolling window keyed on first-send would leak capacity across boundaries and
make "reschedule to the next window" ambiguous. Every instance and every
restart agrees on which window is current.

**Capacity is released when a send fails** (`releaseHourlyCapacity`), so a
recipient that errors out doesn't burn a slot that a working one could use.

### Minimum delay between sends

`peekSenderDelay` reports when a sender next becomes eligible. Critically it is
called **before** the hourly reservation: reserving hourly capacity for work
that cannot send yet inflates the counter and pushes unrelated recipients into
the next hour for no reason.

Deferral is non-advancing — a failed delay-slot check does not itself move the
delay forward, or each retry would push the next send further out (the bug where
40 deferrals reached 39 s).

### Concurrency

| Control | Where |
|---|---|
| `WORKER_CONCURRENCY` (default 5) | BullMQ `Worker` concurrency |
| Claim CAS with lease | Prevents two workers sending the same recipient |
| Outbox claim (`pending → processing`) | Prevents duplicate side effects |
| API rate limit (100 req/min) | `express-rate-limit`, independent of delivery quota |

BullMQ's `maxRetriesPerRequest: null` is required for workers but makes
publish calls hang, so every publish is wrapped in `QUEUE_PUBLISH_TIMEOUT_MS`.

---

## 8. Backend feature map

| Area | Implemented |
|---|---|
| **Scheduler** | `services/scheduler.ts` — transactional schedule + recipients + outbox, owner-scoped idempotency, unique-violation replay, delayed BullMQ job per recipient |
| **Persistence** | 8-table Drizzle schema, claim/lease CAS, reconciliation on boot + 60 s, transactional outbox, retention sweep every 6 h |
| **Rate limiting** | Redis Lua atomic hourly slots, UTC-aligned windows, `peekSenderDelay` ordering, non-advancing delay, capacity release on failure |
| **Concurrency** | Dynamic worker import under `--worker`, per-worker `WORKER_CONCURRENCY`, CAS claim with lease expiry, deduplicated outbox dispatch |
| **Delivery** | Transport abstraction (`ethereal` / `stub`), retry classification, provider IDs persisted, at-most-once at the accept boundary |
| **Search** | Per-recipient Elasticsearch documents, updated on dispatch, `GET /api/v1/emails/search` |
| **Slack** | OAuth with encrypted tokens, rate-limit notifications deduplicated by atomic `notifiedAt` claim |
| **Security** | Server-side HTML sanitizer, helmet headers, timing-safe dashboard auth, 413 passthrough from body-parser, bounded pagination |
| **Observability** | Structured logs with correlation IDs, Prometheus `/metrics`, queue-depth sampling |

---

## 9. Frontend feature map

| Screen | Route | What it does |
|---|---|---|
| **Login** | `/login` | `LoginCard` → `GET /api/v1/auth/google`. Session is an HttpOnly cookie; the token never reaches `localStorage`/`sessionStorage`. |
| **Dashboard** | `/` | Scheduled list, search with debounce, status filters, pagination |
| **Compose** | `/compose` | Recipient entry + **Web Worker CSV parsing**, sender settings, schedule picker, stable idempotency key |
| **Scheduled** | `/scheduled` | Per-recipient email addresses (never schedule-ID slices), `+N` overflow marker, start times |
| **Sent** | `/sent` | Recipient address, status, provider ref, delivery timestamp bound to `sentAt`/`createdAt` |

| Cross-cutting | Detail |
|---|---|
| Data layer | React Query — `queryKey` includes `page`/`limit`/`search`, so pagination is a cache key, not local state |
| Mutation safety | Idempotency key held in a ref, regenerated only on modal open or after success — survives network retries |
| Sanitisation | `isomorphic-dompurify` on the client **and** a server-side allowlist sanitizer before storage |
| Accessibility | WCAG 2.1 AA — ARIA labels, keyboard navigation, focus states, visible labels |
| Styling | Tailwind, Figma-aligned components |

Pagination wires end to end:

```
onPageChange → setPage → params {page, limit, search} → React Query key
             → GET /api/v1/schedules?page=…&limit=…&search=…  (req.query)
             → limit/offset in Postgres, bounded to 100 rows per page
```

---

## 10. Testing

```powershell
# Unit
cd reachinbox-backend; npm test          # 38
cd reachinbox-frontend; npm test         # 37

# Integration (require the stack running)
cd reachinbox-backend
npm run test:security                    # 63 — injection, abuse, secrets, authz
npm run test:failure-injection           # 24 — crash boundaries
npm run test:outages                     # 11 — ES / Slack / Redis outages
npm run load:test                        # 1000+ recipients
npm run test:invariants                  # hourly cap, no duplicates, no drops
npm run verify:recipient-binding         # 10 — real addresses in the list
npm run probe:send-path                  # end-to-end through SMTP

# End-to-end (browser)
cd e2e; npx playwright test              # 29 (1 skipped until Slack reconnects)
```

> Load, invariant, failure-injection and outage suites **require
> `SMTP_TRANSPORT=stub`** — they inject deterministic provider failures that
> real SMTP cannot produce. `test:failure-injection` now fails fast with
> instructions if the transport is wrong, rather than reporting misleading
> zero-call failures.

Real delivery is verified separately with `probe:send-path` against live
Ethereal credentials.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Port 3001 busy | Kill stale `next dev` processes, then `npm run dev` again |
| `EINVAL readlink` on `.next` | OneDrive sync conflict — `Remove-Item -Recurse -Force .next` |
| Slack status shows disconnected after rotating keys | Reconnect in the dashboard; the stored token can't be decrypted with the new `ENCRYPTION_KEY` |
| E2E Slack test skips | Same as above — it reports why rather than hiding |
| Docker build fails on a `.test.ts` file | BuildKit + OneDrive read conflict — `docker-compose build api` again |
| Tests report `transportCalls=0` | Worker isn't on `stub` — `$env:SMTP_TRANSPORT="stub"; docker-compose up -d --build` |
