# Backend update and deployment

The API now runs NestJS 11 with Express 5. The CLI, schematics, testing packages,
and Nest integrations use compatible versions recorded in `bun.lock`. This is
the migration from Nest 10 to 11; it does not skip directly to Nest 12.
Use Node.js 24 LTS and Bun 1.3.14 for this project.

## Deploy both the API and cleanup worker

**Expired-file cleanup now runs in a separate worker. Starting only the API will
not purge expired files.** Run the worker with the same MongoDB and R2 settings
as the API, plus `REDIS_URL`. The worker does not open an HTTP port.

```sh
bun install --frozen-lockfile
bun run build

# API process
bun run start:prod

# Separate supervised process
bun run start:worker
```

New optional settings for the API, and required Redis configuration for the worker:

```dotenv
# Required for the worker; use the same queue database for all worker instances.
REDIS_URL=redis://127.0.0.1:6379/0

# Optional shared statistics cache. Set consistently on API and worker processes.
# Without it, each API uses a local cache with a 15-second TTL.
CACHE_REDIS_URL=redis://127.0.0.1:6379/1

LOG_LEVEL=info
MONGODB_MAX_POOL_SIZE=20
MONGODB_RETRY_ATTEMPTS=3
MONGODB_RETRY_DELAY_MS=3000
# Atlas mongodb+srv SRV/TXT resolver fallback (comma-separated)
DNS_SERVERS=8.8.8.8,1.1.1.1
CRON_DELETE_SCHEDULE=0 0 * * *
CRON_TIMEZONE=Asia/Kolkata
SOFT_DELETE_DAYS=7
```

Use a persistent Redis service with eviction disabled for queues, and supervise
both Node processes with your deployment platform. `rediss://` supports TLS.
Scale API replicas independently. Worker instances use a shared scheduler ID and
global queue concurrency of one. BullMQ provides at-least-once processing, not
an exactly-once guarantee. Successful deletions disappear from subsequent scans;
failed files remain available for retry. Jobs retry up to five attempts with
exponential backoff starting at one minute, and retain up to 100 success/failure
records. Persistent failures must be investigated in worker logs.

During rollout, stop API replicas from the previous version before enabling the
new worker, because old replicas still run their embedded cleanup cron.
Existing authentication state and rate limits also need consideration when
scaling: OTP state and the default throttler store remain process-local.

## Improvements included

- Folder contents uses two grouped count queries regardless of the number of
  direct child folders. Access filters and the response shape are preserved.
  The regression test covers 100 subfolders: two grouped queries replace 200
  per-folder count queries. This is query-count evidence, not a latency benchmark.
- Cleanup pages by `_id`, so a failed deletion cannot trap the process in an
  endless retry loop. The worker retries failures with backoff.
- Pino logs request IDs, HTTP status, and response time. HTTP request serializers
  omit headers, bodies, and raw URLs containing share tokens or search text.
- Search logs each find/count duration, warns at 250 ms, and caps each primary
  query at 3 seconds. Query text is limited to 200 characters. Matching semantics,
  pagination, and existing permission filters are unchanged.
- The superadmin file-statistics endpoint caches results for 15 seconds.
  Successful modifying HTTP requests and cleanup runs invalidate that cache.
  Redis cache errors fall back to MongoDB. Cache results are approximate: concurrent
  requests, download counters, out-of-band database changes, or separate local
  caches can remain stale until TTL expiry. User file lists and auth are not cached.
- MongoDB pooling has a configurable per-process maximum and a bounded wait queue.
  Account for the combined pool size when adding replicas.
- SMTP reuses up to three connections with bounded connection/socket timeouts.
  Email still awaits SMTP acceptance, preserving the existing API behavior.
- `/health` reports process liveness; `/health/ready` checks MongoDB and returns
  HTTP 503 when unavailable. Both paths are unversioned and public.
- Deprecated, unused `csurf` packages were removed. Direct R2 uploads, multipart
  uploads, and support for every file type remain in place; see [UPLOADS.md](UPLOADS.md).

## Measure before further changes

Enable `LOG_LEVEL=debug` in staging to capture fast search queries as well as slow
ones. With representative authorized accounts and realistic data, measure p50/p95
latency and errors for folder contents, search, and statistics while observing
MongoDB CPU, examined documents, connection usage, and API memory.

No production database queries or load tests were executed as part of this update.
Use MongoDB `explain('executionStats')` against representative filters before adding
indexes. Arbitrary case-insensitive substring matching across several fields is
not made efficient simply by adding ordinary field indexes. An indexed search
engine or changed matching behavior needs a separate measured migration.

Express remains the HTTP adapter. Fastify would require changes to the current
Multer, cookie, and raw-response integrations; benchmark that separately.
Nest 11 uses Express 5; the bootstrap explicitly retains extended query parsing.

## Validation and rollout

```sh
bun run build
bun run test -- --runInBand
```

Tests exercise grouped folder counts and owner filters, failed-cleanup progress,
worker scheduling and retry configuration, search query limits, cache behavior,
readiness responses, and API routing/JWT/validation with external services mocked.
Test real MongoDB, Redis, SMTP, and R2 integration in staging before switching
production traffic. This workspace update does not deploy or start those services.

References: [Nest migration guide](https://docs.nestjs.com/migration-guide),
[Nest queues](https://docs.nestjs.com/techniques/queues),
[BullMQ schedulers](https://docs.bullmq.io/guide/job-schedulers/),
[BullMQ global concurrency](https://docs.bullmq.io/guide/queues/global-concurrency),
[Nest health checks](https://docs.nestjs.com/recipes/terminus),
[Pino integration](https://github.com/iamolegga/nestjs-pino),
[SMTP pooling](https://nodemailer.com/smtp/pooled).
