# ReachInbox: Email Scheduler

Bulk email scheduling with durable delivery guarantees. Schedule a campaign,
and it sends on time, respects rate limits, and recovers cleanly from a crash
or restart.

- **Backend:** Express + TypeScript, PostgreSQL, Drizzle ORM, BullMQ, Redis
- **Frontend:** Next.js, React, TypeScript, Tailwind CSS, React Query
- **Auth:** Google OAuth with an HttpOnly session cookie
- **Ports:** API 3000, web 3001, PostgreSQL 5432, Redis 6379, Elasticsearch 9200

---

## Quick start

You need **Node.js 20+**, **Docker Desktop**, and a terminal.

### Step 1. Get the code and fill in secrets

```powershell
cd reachinbox-backend
Copy-Item .env.example .env
notepad .env
```

Fill in every `replace-with...` value. See
[Section 3](#3-ethereal-email-and-environment-variables) for exactly what goes
where and how to generate it.

### Step 2. Start the backend

```powershell
docker-compose up -d --build
```

Wait about 30 seconds for the containers to become healthy:

```powershell
docker-compose ps
```

Check it is responding:

```powershell
Invoke-WebRequest http://localhost:3000/health/live
```

### Step 3. Start the frontend

Open a **second** terminal:

```powershell
cd reachinbox-frontend
npm install
npm run dev
```

### Step 4. Open the app

Go to **http://localhost:3001** and sign in with Google.

That is the whole loop. Everything below is reference material.

---

## Table of contents

1. [Running the backend](#1-running-the-backend)
2. [Running the frontend](#2-running-the-frontend)
3. [Ethereal Email and environment variables](#3-ethereal-email-and-environment-variables)
4. [Architecture overview](#4-architecture-overview)
5. [How scheduling works](#5-how-scheduling-works)
6. [How persistence on restart is handled](#6-how-persistence-on-restart-is-handled)
7. [How rate limiting and concurrency work](#7-how-rate-limiting-and-concurrency-work)
8. [Backend features](#8-backend-features)
9. [Frontend features](#9-frontend-features)
10. [Testing](#10-testing)
11. [Troubleshooting](#11-troubleshooting)
12. [License](#12-license)

---

## 1. Running the backend

### Option A: Docker Compose (recommended)

This starts the databases and the application together.

```powershell
cd reachinbox-backend
docker-compose up -d --build
```

| Service | What it does |
|---|---|
| `postgres` | Source of truth for schedules, recipients, attempts, outbox |
| `redis` | Queues, rate limit counters, locks |
| `elasticsearch` | Search index (derived data, never blocks startup) |
| `api` | Express HTTP server on port 3000 |
| `worker` (2 copies) | The processes that actually send email |

Workers are separate from the API. Starting more API replicas does not increase
your send rate. The worker entry point is:

```yaml
command: ["node", "dist/index.js", "--worker"]
environment:
  - WORKER_MODE=1
  - WORKER_CONCURRENCY=5
```

`index.ts` only loads the worker code when `--worker` is passed, so an API
process can never accidentally start sending email.

### Option B: Local dev server

Use this when you want hot reload while the databases still run in Docker.

```powershell
cd reachinbox-backend
docker-compose up -d postgres redis elasticsearch
npm install
npm run dev
```

### Check it is alive

```powershell
Invoke-WebRequest http://localhost:3000/health/live
Invoke-WebRequest http://localhost:3000/health/ready
```

**BullMQ dashboard** (operator only, read only by default):

```
http://localhost:3000/admin/queues?token=YOUR_DASHBOARD_TOKEN
```

### Useful commands

```powershell
npm run typecheck     # type check only
npm test              # unit tests against real Redis and PostgreSQL
npm run db:migrate    # apply database migrations
npm run db:studio     # open Drizzle Studio
npm run build         # compile to dist/
```

---

## 2. Running the frontend

```powershell
cd reachinbox-frontend
npm install
npm run dev
```

Open **http://localhost:3001**.

The frontend needs only the API URL. `next.config.js` forwards every
`/api/v1/*` request to the backend:

```js
destination: `${process.env.API_URL || "http://localhost:3000"}/api/v1/:path*`
```

Because the default is already `localhost:3000`, you normally need no
configuration. Set `API_URL` only if the backend runs somewhere else.

```powershell
# reachinbox-frontend/.env.local
API_URL=http://localhost:3000
```

> `reachinbox-frontend/.env.example` also lists `NEXTAUTH_*` and `GOOGLE_*`
> values. These are **not used**. OAuth happens entirely on the backend, and the
> frontend reads no environment variables other than `API_URL`. You can ignore
> that file.

### Useful commands

```powershell
npm run typecheck   # type check only
npm test            # unit tests
npm run build       # production build
```

---

## 3. Ethereal Email and environment variables

### What is Ethereal

Ethereal is a free testing email service. It accepts your email and shows it in
a web inbox so you can confirm sending works. It does **not** deliver to real
inboxes.

Good for development. For production, use a real provider such as AWS SES,
Postmark, or Resend.

### Get Ethereal credentials

1. Sign up at **https://ethereal.email** (no credit card needed)
2. Open **Accounts** then **Create new account**
3. Copy the **SMTP username** and **SMTP password** it gives you

### Generate secure secrets

Run these to create random values:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### The variables

`src/config/env.ts` checks these when the app starts. If a required one is
missing, the app prints exactly which and exits.

**Required (the app will not start without these):**

| Variable | What to put |
|---|---|
| `DATABASE_URL` | `postgresql://reachinbox:reachinbox@localhost:5432/reachinbox` |
| `REDIS_URL` | `redis://:reachinbox@localhost:6379/0` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` |
| `GOOGLE_CLIENT_ID` | From Google Cloud console, OAuth credentials |
| `GOOGLE_CLIENT_SECRET` | From the same place |
| `GOOGLE_CALLBACK_URL` | `http://localhost:3000/api/v1/auth/google/callback` |
| `SLACK_CLIENT_ID` | From https://api.slack.com/apps |
| `SLACK_CLIENT_SECRET` | From the same place |
| `JWT_SECRET` | At least 32 random characters. Signs your login cookie. |
| `ENCRYPTION_KEY` | A 32 byte base64 key. Encrypts stored Slack tokens. |
| `SMTP_USER` | Your Ethereal username (an email address) |
| `SMTP_PASS` | Your Ethereal password |

**Optional (these have sensible defaults):**

| Variable | Default | Notes |
|---|---|---|
| `SMTP_HOST` | `smtp.ethereal.email` | |
| `SMTP_PORT` | `587` | |
| `SMTP_TRANSPORT` | `ethereal` | `ethereal`, `brevo`, or `stub`. See the note below. |
| `SMTP_FROM` | empty | Envelope sender. Empty means "send as the account `SMTP_USER` belongs to". See below. |
| `BREVO_API_KEY` | empty | Brevo API key, used when `SMTP_TRANSPORT=brevo` |
| `BREVO_API_URL` | `https://api.brevo.com` | |
| `DASHBOARD_TOKEN` | empty | Empty disables the BullMQ dashboard entirely |
| `DASHBOARD_READ_ONLY` | `true` | Blocks anything except GET/HEAD/OPTIONS |
| `WORKER_CONCURRENCY` | `5` | Jobs processed at once per worker |
| `API_RATE_LIMIT_MAX` | `100` | Requests allowed per window |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | The window above, in milliseconds |
| `FRONTEND_URL` | `http://localhost:3001` | |
| `MAX_RECIPIENTS_PER_SCHEDULE` | `1000` | |

**Choosing a transport.** `SMTP_TRANSPORT` picks how mail leaves the process,
and the choice is forced by the host rather than by preference:

| Value | Reaches the provider over | Use when |
|---|---|---|
| `ethereal` | SMTP (`SMTP_HOST:SMTP_PORT`) | You control the host, or you are testing locally |
| `brevo` | HTTPS (`BREVO_API_URL`) | The host blocks outbound SMTP ports |
| `stub` | nothing | Load and failure-injection runs, where delivery must not happen |

`brevo` exists because **free Render web services block all outbound traffic to
SMTP ports 25, 465 and 587.** Ethereal's relay, and Brevo's own relay, are both
unreachable from such a host no matter which credentials they are given — the
connection simply times out. Port 443 is not blocked, and the HTTP API is the
same product behind the same account, so `brevo` is a transport swap rather than
a downgrade. On a paid instance, or anywhere else that permits SMTP, `ethereal`
works unchanged.

With `brevo`, set `SMTP_FROM` to a sender address the provider has verified;
Brevo rejects anything else, naming the sender field in the error.

**Who the mail is sent as:** users schedule campaigns under their own address,
but a provider will only send from a mailbox it is entitled to send from. On a
shared account those are different addresses, so the envelope sender is resolved
once, in this order: `SMTP_FROM`, then `SMTP_USER`, then the address the caller
asked for. The user's own address remains the identity shown in the UI.

**Diagnosing a send failure:** `GET /health/smtp` reports the transport
configuration with credentials reduced to present/absent, and whether the
provider has accepted them. The three signals are separate because they are
fixed in different places:

- `credentialsConfigured: false` — the env vars never reached the process.
- `fromSource: "requested"` — the envelope sender is the signed-in user's own
  address, which no provider will send from on a shared account.
- `verified: false` — the credential arrived and the provider refused it, or
  could not be reached. `verifyError` says which; for SMTP it carries the
  response code (`530` means no credentials were offered, `535` that they were
  refused), and for the HTTP transport it carries the status and the provider's
  own message.

`verified` is `null` until the startup probe has run, and the worker also logs
one line saying whether the provider accepted the credentials. Without that,
the only evidence of a bad configuration was a wall of `failed` rows minutes
later, all carrying the same opaque code.

**Google OAuth setup checklist:**

1. Create a project at https://console.cloud.google.com
2. Enable the Google+ or People API
3. Create **OAuth 2.0 Client ID** credentials
4. Add `http://localhost:3000/api/v1/auth/google/callback` as an authorised
   redirect URI
5. Copy the client ID and secret into your `.env`

**Slack setup checklist:**

1. Create an app at https://api.slack.com/apps
2. Under **OAuth & Permissions**, add the scopes `chat:write` and
   `channels:read`
3. Install the app to your workspace
4. Copy the client ID and secret into your `.env`

### Where the file goes

```powershell
cd reachinbox-backend
Copy-Item .env.example .env
notepad .env
```

`.env` is ignored by git in every subproject. The files committed to GitHub
contain only `.env.example` templates, never real values.

> **Important:** if you ever rotate `ENCRYPTION_KEY`, any Slack token you
> already saved becomes unreadable. You will need to disconnect and reconnect
> Slack in the dashboard.

---

## 4. Architecture overview

```
   Browser
      |
      v
+---------------------------+
|  Next.js  :3001           |
|  login, dashboard,        |
|  compose, tables          |
+-------------+-------------+
              |  forwards /api/v1 to the API
              v
+---------------------------+
|  Express  :3000           |
|  auth, schedules,         |
|  emails, slack            |
+------+-------------+------+
       |             |
       | writes      | queues after commit
       v             v
+-------------+   +---------------------------+
| PostgreSQL  |   | Redis / BullMQ            |
| source of   |   | delayed jobs,             |
| truth       |   | rate limit counters,      |
|             |   | atomic Lua scripts        |
| outbox      |   +------------+--------------+
| events  ----+----------------+
+-------------+                |
                               v
                    +---------------------------+
                    |  Worker  (--worker)       |
                    |  emailWorker  --> SMTP    |
                    |  outboxWorker --> ES      |
                    |                --> Slack  |
                    +---------------------------+
```

**The main idea: PostgreSQL is the source of truth, and queues are only a
notification system.** Anything a queue loses can be rebuilt by reading the
database again. That single rule is what makes restarts safe.

### The two process modes

| Mode | Started by | What it does |
|---|---|---|
| API | `docker-compose up` or `npm run dev` | Serves HTTP. Runs reconciliation on startup and every 60 seconds. |
| Worker | `node dist/index.js --worker` | Sends email and dispatches outbox events. Runs no HTTP at all. |

---

## 5. How scheduling works

When you create a campaign, one database transaction does everything:

```
POST /api/v1/schedules
        |
        v
  ONE TRANSACTION
  1. Resolve the idempotency key for this owner
  2. Insert the schedule
  3. Insert recipients, all set to status 'queued'
  4. Insert one outbox event per recipient
        |
        v  (committed)
  Enqueue a delayed BullMQ job
  job id: recipient-<uuid>-1
        |
        v  (after the scheduled time)
  Worker claims it --> sends via SMTP --> writes attempt --> marks terminal
```

**Each recipient is its own job.** A 1000 person campaign becomes 1000 small
jobs, each retried, cancelled, and rate limited on its own.

### Decisions that matter

| Decision | Why |
|---|---|
| Recipients start at `queued`, not `scheduled` | The worker claims rows whose status is `queued`. Starting at `scheduled` would mean the claim never succeeds. |
| Job lookup uses the recipient UUID | The queue passes `recipientId`, and the worker queries by primary key. A `scheduleId:index` compound key would match nothing. |
| Job IDs use dashes, never a single colon | BullMQ rejects job IDs containing a single colon and silently drops them. `recipient-<uuid>-1` works. `outbox:x` does not. |
| Duplicate requests replay the original | A unique index on `(owner_id, idempotency_key)` means the second request returns the first one's result instead of creating a duplicate. |
| Worker code loads only with `--worker` | A normal import would turn every API replica into a sending process. |

### Idempotency

The client sends an `Idempotency-Key` header (or an `idempotencyKey` field in
the body). That key belongs to the logged in user, so two different users can
use the same key without interfering.

The compose screen keeps the key in a React ref. It generates a new one only
when the form opens or after a successful submit, so a retried network request
reuses the same key instead of creating a second campaign.

---

## 6. How persistence on restart is handled

Nothing important lives only in Redis. When the API starts it reads the
database:

```ts
await reconcilePendingWork();                      // on startup
setInterval(reconcilePendingWork, 60_000);         // and every minute
```

`reconciliation.ts` looks at three groups of recipients:

| Group | Where it finds them | What it does |
|---|---|---|
| Never queued | status `scheduled` or `queued` | Republishes the job |
| Died mid send | status `sending` with an expired lease | Clears the claim, sets it back to `queued`, republishes |
| Already finished | `sent`, `failed`, `cancelled` | Leaves it alone, never sends again |

Finished recipients are excluded from both checks, which is what stops a
restart from sending a duplicate.

### Claim and lease

The worker takes ownership with an atomic conditional update:

```sql
UPDATE recipients
SET    status = 'sending', claimed_by = $1, claim_expires_at = $2
WHERE  id = $3
  AND  (status = 'queued'
        OR (status = 'sending' AND claim_expires_at < now()))
```

This gives two properties:

- **A crash does not lose work.** If a worker dies, its lease expires and
  another worker picks the row up.
- **A crash does not resend.** If the process died after the provider accepted
  the message but before we recorded it, recovery sees the stored provider ID
  and does not call SMTP again.

### Transactional outbox

Effects that must not be lost, such as Elasticsearch indexing and Slack
notifications, are written to an `outbox_events` table in the same transaction
as the change itself. A separate worker delivers them afterwards.

```
write state + outbox event  (one transaction)
            |
            v
   outboxWorker
     - claim event: pending -> processing
     - indexEmailRecord
     - sendSlackRateLimitEvent
     - mark completed (or retry, up to 5 times)
```

Those two functions are imported only by the outbox worker, never by the send
worker, so email delivery stays independent of both.

If Elasticsearch or Slack goes down, the event simply stays pending and is
retried. Email sending is never blocked or failed because of it.

---

## 7. How rate limiting and concurrency work

### Hourly limit

Each schedule has an `hourlyLimit`. A Redis Lua script reserves a slot and
checks the limit in one atomic step, so two workers cannot both grab the last
slot.

The time window is aligned to the whole UTC hour:

```ts
Math.floor(now / 3600_000) * 3600_000
```

Every worker, and every process restart, agrees on which hour is current. A
window based on "first send" would drift and make "send in the next hour"
unclear.

**If a send fails, its slot is returned** so a broken recipient does not use up
capacity a working one could have had.

### Minimum gap between sends

`peekSenderDelay` checks when a sender is next allowed to send. It runs
**before** the hourly reservation. Reserving an hourly slot for a message that
cannot go out yet would waste the slot and push unrelated recipients into the
next hour.

When a send is deferred, the delay is not increased as a side effect. If it
were, every retry would push the next attempt further out and the delays would
grow without limit.

### Concurrency controls

| Control | Where |
|---|---|
| `WORKER_CONCURRENCY`, default 5 | How many jobs one worker handles at once |
| Atomic claim with a lease | Two workers can never send the same recipient |
| Outbox event claim | An event is only delivered once |
| API limit, 100 requests per minute | Protects the API and is separate from the email limit |

One BullMQ setting worth knowing: `maxRetriesPerRequest: null` is required for
workers, but it makes publish calls block forever. Every publish is therefore
wrapped in a timeout (`QUEUE_PUBLISH_TIMEOUT_MS`).

---

## 8. Backend features

| Area | What is implemented |
|---|---|
| **Scheduler** | `services/scheduler.ts`. Writes the schedule, recipients, and outbox events in one transaction. Owner scoped idempotency. Handles concurrent duplicate requests by replaying the winner. |
| **Persistence** | 8 table schema in Drizzle. Claim and lease with an atomic conditional update. Reconciliation on startup and every 60 seconds. Transactional outbox. Retention sweep every 6 hours. |
| **Rate limiting** | Atomic Lua slots in Redis. Windows aligned to the UTC hour. Delay checked before the hourly reservation. Slots returned when a send fails. |
| **Concurrency** | Worker code loaded only under `--worker`. Configurable concurrency. Atomic claim with lease expiry. Outbox events delivered exactly once. |
| **Delivery** | Transport abstraction with `ethereal` and `stub` modes. Retry classification. Provider IDs stored. Never sends twice at the acceptance boundary. |
| **Search** | One Elasticsearch document per recipient, updated when the email is dispatched. Exposed at `GET /api/v1/emails/search`. |
| **Slack** | OAuth with tokens encrypted at rest. Rate limit notifications deduplicated so each sender and window gets at most one. |
| **Security** | Server side HTML sanitizer, security headers, timing safe token comparison, dashboard disabled when unconfigured, pagination capped at 100 rows. |
| **Observability** | Structured logs with correlation IDs, Prometheus metrics at `/metrics`, queue depth sampled every 15 seconds. |

---

## 9. Frontend features

### Screens

| Screen | Route | What it does |
|---|---|---|
| **Login** | `/login` | Sends you to Google sign in. The session is an HttpOnly cookie, so the token never touches browser storage. |
| **Dashboard** | `/` | Scheduled campaigns with search, status filters, and pagination. |
| **Compose** | `/compose` | Add recipients, upload a CSV (parsed in a Web Worker so the UI never freezes), set the schedule, pick the sender. |
| **Scheduled** | `/scheduled` | Shows the real recipient email address for each campaign, plus a `+N` marker when there are more. |
| **Sent** | `/sent` | Shows recipient address, status, provider reference, and the delivery time. |

### How it is wired

| Concern | How it works |
|---|---|
| Data fetching | React Query. The query key includes page, limit, and search, so changing page is a cache key change rather than local state. |
| Safe retries | The idempotency key lives in a ref. It changes only when the form opens or after a successful submit. |
| HTML safety | DOMPurify on the client and a separate allowlist sanitizer on the server before anything is stored. |
| Accessibility | WCAG 2.1 AA. ARIA labels, keyboard navigation, visible focus states. |
| Styling | Tailwind CSS. |

### Pagination end to end

```
Click next
  -> setPage
  -> params { page, limit, search }
  -> React Query refetches
  -> GET /api/v1/schedules?page=2&limit=20
  -> Express reads req.query
  -> LIMIT / OFFSET in PostgreSQL
```

---

## 10. Testing

### Unit tests

```powershell
cd reachinbox-backend;  npm test     # 38 tests
cd reachinbox-frontend; npm test     # 37 tests
```

### Integration tests

These need the stack running.

```powershell
cd reachinbox-backend

npm run test:security               # 63 assertions: injection, abuse, secrets, auth
npm run test:failure-injection      # 24 assertions: crash boundaries
npm run test:outages                # 11 assertions: ES, Slack, Redis outages
npm run load:test                   # 1000+ recipients at once
npm run test:invariants             # hourly cap, no duplicates, nothing dropped
npm run verify:recipient-binding    # 10 assertions: real addresses in the list
npm run probe:send-path             # full path through real SMTP
```

### Browser tests

```powershell
cd e2e
npm install
npx playwright test                 # 29 tests
```

> **Set `SMTP_TRANSPORT=stub` before running load, invariant, failure
> injection, or outage tests.** They need to inject specific provider failures
> that real SMTP cannot produce on demand. `test:failure-injection` now exits
> immediately with instructions if the transport is wrong, instead of printing
> confusing failures.

Real email delivery is checked separately with `npm run probe:send-path`, which
uses your actual Ethereal credentials.

---

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| Port 3001 is busy | Close other `next dev` processes, then run `npm run dev` again |
| `EINVAL readlink` in `.next` | OneDrive is syncing the folder. Run `Remove-Item -Recurse -Force .next` |
| Slack shows as disconnected after changing keys | Reconnect it in the dashboard. The old token cannot be decrypted with the new `ENCRYPTION_KEY`. |
| The Slack E2E test skips | Same cause as above. It prints its reason rather than hiding it. |
| Docker build fails on a `.test.ts` file | A transient file lock. Run `docker-compose build api` again. |
| Tests report `transportCalls=0` | The worker is not using the stub transport. Run `$env:SMTP_TRANSPORT="stub"; docker-compose up -d --build` |
| App exits saying a variable is missing | The message names it. Add it to `reachinbox-backend/.env` and restart. |
| Login fails immediately | Check `GOOGLE_CALLBACK_URL` matches the redirect URI registered in Google Cloud exactly. |

---

## 12. License

Released under the [MIT License](LICENSE).
