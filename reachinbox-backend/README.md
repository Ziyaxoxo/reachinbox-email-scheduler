# ReachInbox Backend

Production-grade email scheduling backend built with TypeScript, Express, PostgreSQL, BullMQ/Redis, Elasticsearch, and Ethereal SMTP.

## Architecture

- **API Layer**: Express with JWT auth, zod validation, structured errors
- **Database**: PostgreSQL with Drizzle ORM, transactional outbox pattern
- **Queue**: BullMQ with Redis for delayed job scheduling (no cron)
- **Workers**: Separate processes for email sending and outbox processing
- **Search**: Elasticsearch as derived read model
- **Notifications**: Slack OAuth with encrypted token storage

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose

### Setup

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your credentials

# Start all services
docker-compose up -d

# Run database migrations
npm run db:generate
npm run db:migrate

# Start development server
npm run dev
```

### Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `ELASTICSEARCH_URL` | Elasticsearch endpoint |
| `SMTP_HOST` | Ethereal SMTP host |
| `SMTP_USER` | Ethereal SMTP username |
| `SMTP_PASS` | Ethereal SMTP password |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `SLACK_CLIENT_ID` | Slack OAuth client ID |
| `SLACK_CLIENT_SECRET` | Slack OAuth client secret |
| `JWT_SECRET` | Secret for JWT signing (min 32 chars) |
| `ENCRYPTION_KEY` | Key for AES-256-GCM encryption |

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/auth/google` | Start Google OAuth |
| `GET` | `/api/v1/auth/google/callback` | OAuth callback |
| `POST` | `/api/v1/auth/logout` | Logout |
| `GET` | `/api/v1/me` | Current user |
| `POST` | `/api/v1/schedules` | Create schedule |
| `GET` | `/api/v1/schedules` | List schedules |
| `GET` | `/api/v1/schedules/:id` | Schedule detail |
| `GET` | `/api/v1/emails/sent` | List sent emails |
| `POST` | `/api/v1/slack/connect` | Start Slack OAuth |
| `GET` | `/api/v1/slack/status` | Slack connection status |
| `DELETE` | `/api/v1/slack/connection` | Disconnect Slack |
| `GET` | `/health/live` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe |
| `GET` | `/admin/queues` | BullMQ dashboard |
| `GET` | `/metrics` | Prometheus metrics |

### Schedule list recipient summary

`GET /api/v1/schedules` returns each schedule with a recipient summary so the
Scheduled view can render a real address rather than an identifier:

| Field | Meaning |
|---|---|
| `firstRecipientEmail` | Address of the recipient with the lowest `sequenceNo`, i.e. the first one due to send. `null` only if a schedule somehow has no recipients. |
| `recipientCount` | Total recipients on the campaign, for the "+N" overflow marker. |

The summary is resolved in a single grouped query over the page's schedule ids
(`recipients_schedule_idx`), not one query per row, so list latency is unchanged
regardless of page size. Ordering by `sequenceNo` matters: the first address
shown is the first one the recipient actually receives.

## Key Design Patterns

### Transactional Outbox
Schedule creation writes to the database and outbox in the same transaction. A separate worker processes outbox events for Elasticsearch indexing and Slack notifications.

### Redis Lua Scripts for Rate Limiting
Two Lua scripts ensure atomic rate limiting across multiple worker instances:
- `reserveHourlyCapacity`: Atomic hourly slot reservation
- `advanceSenderDelay`: Atomic sender delay enforcement

### Idempotent Job Enqueue
Job IDs follow the pattern `recipient:{recipientId}:{attempt}`, making duplicate enqueues safe.

### Claim/Lease Pattern
Workers atomically claim recipients using `UPDATE ... WHERE status='queued'`, ensuring only one worker processes each recipient.

## Development

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint

# Database studio
npm run db:studio
```

## Testing strategy

`npm test` runs unit and concurrency tests against the real Redis and PostgreSQL
containers, so the atomicity claims are proven rather than mocked.

| Command | What it proves |
| --- | --- |
| `npm test` | Lua atomicity under contention, recipient claim exclusivity, idempotency per owner, dedupe, terminal-state guards |
| `npm run load:test` | 1000+ near-simultaneous recipients: bounded memory, durable persistence, order preservation, queue absorption (BE-SCHED-005/006) |
| `npm run test:invariants` | Hourly cap never exceeded, excess deferred not dropped, no duplicate sends, terminal recipients never resent, minimum delay holds across instances (SRS section 22) |
| `npm run probe:send-path` | End-to-end: create, claim, attempt, outbox, Elasticsearch |
| `npm run test:failure-injection` | Crash boundaries and provider error classification (24 assertions). **Requires `SMTP_TRANSPORT=stub`** — it exits immediately with instructions on any other transport rather than reporting misleading zero-call failures. |
| `npm run test:outages` | Dependency outages: Elasticsearch, Slack, Redis |
| `npm run test:security` | API-level security: injection, abuse bounds, secret exposure, authz (63 assertions) |
| `npm run verify:recipient-binding` | The schedule list returns a real recipient address and count, single and multi recipient (10 assertions) |
| `npm run retention:sweep` | Retention policy executes and reports |

### Running the load and invariant tests

Both need the infrastructure up and workers on the stub transport so nothing is
really delivered.

```powershell
# Workers in stub mode
$env:SMTP_TRANSPORT = "stub"
$env:WORKER_CONCURRENCY = "5"
docker-compose up -d --build

# Invariant test: workers must be RUNNING so they consume
npm run test:invariants

# Load test: stop workers first for a deterministic queue measurement
docker-compose stop worker
npm run load:test
docker-compose start worker

# Restore the real transport
$env:SMTP_TRANSPORT = "ethereal"
docker-compose up -d
```

### Test seams

`SMTP_TRANSPORT=stub` selects an in-process transport that consumes rate-limit
capacity, records attempts and returns a provider id without sending mail, so
the worker path under test stays identical to production.
`SMTP_STUB_LATENCY_MS` simulates a slow provider.

The stub reads its failure mode per call from the Redis key
`test:stub:config`, so a test can flip it at runtime without restarting the
workers, and appends every provider call to `test:stub:sendlog`. Reading the
send log is what lets a test prove the worker did *not* re-send: a duplicate
call that happened to succeed would still leave plausible-looking database rows.

```jsonc
// test:stub:config
{
  "failWith": "ECONNRESET",
  "classification": "transient",   // transient | permanent | ambiguous
  "failRecipient": "x@example.com", // scope the failure to one address
  "failFirstN": 1
}
```

`failRecipient` is what makes injected failures deterministic. A process-wide
counter starts at boot, so a plain `failFirstN` is already consumed by whatever
the worker happened to send first.

The API process never instantiates a worker: `src/index.ts` imports the worker
modules dynamically only when launched with `--worker`. Importing them for side
effects previously made every API replica a send worker, so effective
concurrency silently scaled with the number of API pods.

### Failure injection

`npm run test:failure-injection` exercises the crash boundaries that are easy to
get wrong, asserting on transport call counts rather than only on rows.

| Scenario | Expected |
| --- | --- |
| Crash after provider acceptance, before the status update | Recovered to `sent` from the durable attempt, with zero further SMTP calls |
| Crash after claim, before any SMTP contact | Expired lease reclaimed, delivered exactly once |
| A live lease held by another worker | Not stolen; no second send |
| Transient provider error | Retried, then delivered; both attempts audited |
| Permanent provider error | Terminal, not retried |
| Ambiguous provider outcome | Bounded: recorded and audited, never blind-retried |

`npm run test:outages` stops real containers and asserts the degradation
contract: Elasticsearch down still delivers and its outbox event is not dropped;
Slack unavailable never fails an email; Redis down leaves the database
authoritative.

Set `FI_BACKEND_DIR` if the compose file is not in the working directory.

### Security suite

`npm run test:security` runs against the live API with a real session token, so
the production middleware stack is what is under test.

| Category | Assertions |
| --- | --- |
| SQL injection | Search payloads treated as data; `schedules` table intact afterwards |
| ES query injection | Malformed queries handled without a 5xx |
| Payload abuse | Recipient cap, oversized body, out-of-range numbers, deep nesting, mass assignment |
| Secret exposure | SMTP/Slack/JWT/Google secrets and connection strings absent from six endpoints |
| Authorization | No session, garbage token, `alg:none` downgrade, wrong signature, ghost user |
| Security headers | Helmet headers present on unauthenticated routes |
| Abuse rate limiting | Sustained reads throttled independently of email quota |

`e2e/tests/security.spec.ts` covers the browser half: stored XSS does not
*execute* in the application origin, the client bundle contains no server
secrets, the session token never reaches `localStorage`/`sessionStorage`, the
cookie is HttpOnly + SameSite, and metrics carry no recipient addresses.

`scripts/verifyXssAssertion.ts` is a negative control: it runs the XSS payloads
with the sanitizer enabled and bypassed, proving the stored-value assertion can
actually fail rather than passing vacuously.

### Error status passthrough

Body-parser, cookie-parser and urlencoded errors carry their own `status`. The
error handler honours a 4xx `status`/`statusCode` instead of collapsing
everything non-`AppError` into a 500, so an oversized payload is reported as
413 rather than being logged and alerted on as a server fault.

BullMQ silently ignores an `add()` whose `jobId` is already held by a job in the
`failed` or `completed` set. That makes a deterministic job id a trap for
recovery: a dispatch that exhausts its retries returns the database row to
`pending`, but every later republication would be dropped, stranding the event.

`republishDeadJob` removes a dead entry before re-adding while leaving live jobs
untouched, so ordinary duplicate publication stays idempotent. Both the outbox
dispatcher and reconciliation go through it.

### Rate limiter ordering

The worker peeks the sender's next-eligible-send time before reserving hourly
capacity. Reserving an hourly slot for work that cannot send yet inflates the
window counter and can push unrelated recipients past the limit into the next
hour. When a sender is inside its minimum-delay window, the recipient is
deferred without touching hourly capacity at all.

The delay Lua script only advances the timestamp on a successful reservation. A
failed reservation reports the wait and leaves the key untouched; advancing on
failure is a feedback loop where each deferral pushes the next send further
out.

## Docker

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f api
docker-compose logs -f worker

# Stop all services
docker-compose down
```

## License

MIT
