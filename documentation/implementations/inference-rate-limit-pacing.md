# Plan: paced (token-bucket) rate limits for inference and embedding calls

Branch: `feat/rate-limit-pacing` (git identity: unimatrix099 <unimatrix099@github.com>)
Builds on: [inference-rate-limiting.md](inference-rate-limiting.md) (PR #1)

## Problem

The current limiter is one **fixed window** per kind: at most N calls per `*_RATE_LIMIT_WINDOW_MS`.
Real providers publish several limits at once, e.g. **20 requests/minute and 1000 requests/day**:

- A 1-minute window respects 20/min but lets a backlog spend the whole daily quota in ~50 minutes,
  then everything is blocked for ~23 hours.
- A 1-hour window of 40 respects the daily total, but the 40 go out in the first minutes
  (breaking 20/min) and the queue then idles for the rest of the hour.

Measured in production (2026-10-01 logs) there is a second problem: **queue churn**. A rate-limited
job is dequeued, prepares its input, hits the limit, and is rescheduled; liteque then immediately
dequeues the next job. The worker cycles through the whole backlog every few hundred ms, each cycle
writing to SQLite, which contributed to `SqliteError: database is locked` in `admin.backgroundJobsStats`
while "Regenerate embeddings" was enqueueing in 1000-row pages.

## Goal

- Respect **every** configured provider limit (per minute / hour / day) in **every rolling window**.
- **Spread** calls evenly over the long window, while allowing a configurable **burst** so a few
  new bookmarks are processed immediately.
- No queue churn while limited; new bookmarks (priority 0) keep going before admin backlog
  jobs (`QueuePriority.Low`).
- Settings via env vars. This is a complete reimplementation: the fixed-window
  `*_RATE_LIMIT_WINDOW_MS` / `*_RATE_LIMIT_MAX_REQUESTS` pair from PR #1 is **removed**.

## Algorithm: GCRA (token bucket)

Each configured limit "L requests per period P" becomes one GCRA bucket, the standard single-value
form of a token bucket (only a "theoretical arrival time" `tat` is stored per bucket):

- burst `b = min(BURST, L)`
- emission interval `T = ceil(P / (L - b + 1))` (integer milliseconds)
- tolerance `τ = (b - 1) · T`
- request at time `now` conforms iff `max(tat, now) - τ <= now`; if so `tat = max(tat, now) + T`;
  otherwise wait `retryAfter = max(tat, now) - τ - now`.

For any rolling window `W < P` this admits at most `floor(W / T) + b <= L` requests, so the limit
holds exactly. A call is allowed only when **all** buckets of its kind conform, and no bucket is
updated unless all conform (all-or-nothing, so a denial consumes nothing).

### Verified by simulation (greedy client, 3 days, integer ms)

| Limits | Burst | First minute | Max in any 60 s | Max in any 24 h | Steady spacing |
|---|---|---|---|---|---|
| 20/min + 1000/day | 1 | 1 | 1 | 1000 | 86.4 s |
| 20/min + 1000/day | 10 | 10 | 10 | 1000 | 87.2 s |
| 20/min + 1000/day | 20 | 20 | 20 | 1000 | 88.1 s |
| 40/min + 1000/day | 10 | 10 | 10 | 1000 | 87.2 s |
| 20/min only | 1 | 20 | 20 | 28 800 | 3.0 s |
| 20/min only | 20 | 20 | 20 | 1 459 | **60 s** |

Trade-off to document: a bucket's sustained rate is `(L - b + 1) / P`, so a burst close to the
**binding** limit wastes throughput (last row). With a daily limit binding, burst 10-20 costs 1-2%
of the daily budget; with only a per-minute limit, keep burst small.

Daily limits are treated as **rolling 24 h**, which is safe for providers that instead reset at a
fixed time (it may leave a little quota unused).

## Configuration (`packages/shared/config.ts`)

Per kind (`INFERENCE_` and `EMBEDDING_`), all optional, integers `>= 1`:

| Variable | Meaning |
|---|---|
| `*_RATE_LIMIT_PER_MINUTE` | provider limit per rolling minute |
| `*_RATE_LIMIT_PER_HOUR` | provider limit per rolling hour |
| `*_RATE_LIMIT_PER_DAY` | provider limit per rolling 24 h |
| `*_RATE_LIMIT_BURST` | requests allowed back-to-back after idle, configured **separately for LLM and embeddings**; default **1** (even spacing, full throughput); clamped to the smallest configured limit with a startup warning; ignored with a warning when no limit is set |

Parsed into `serverConfig.inference.rateLimit` / `serverConfig.embedding.rateLimit` as
`{ limits: { limit: number; periodMs: number }[]; burst: number } | null` (null when no limit is set).
Example for the reported provider: `*_PER_MINUTE=20`, `*_PER_DAY=1000`, `*_BURST=10`.

Limits and burst are **per kind**: LLM (`INFERENCE_*`) and embeddings (`EMBEDDING_*`) each have
their own buckets and budget; nothing is shared between them.

## Implementation steps

### 1. Limiter API: `packages/shared/ratelimiting.ts`
Add to `RateLimitClient` (existing `checkRateLimit` stays for API routes and crawler domains):

```ts
export interface PacedLimit { limit: number; periodMs: number }
export interface PacedRateLimitConfig { name: string; limits: PacedLimit[]; burst: number }
export type PacedRateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

acquirePaced(config: PacedRateLimitConfig, key: string): PacedRateLimitResult | Promise<PacedRateLimitResult>;
```
Shared helper `gcraParams(limit, burst) -> { emissionMs, toleranceMs }` so both plugins use the
same integer maths.

### 2. In-memory plugin: `packages/plugins/ratelimit-memory/src/index.ts`
`Map<string, number>` of `tat` per `name:key:limitIndex`; all-or-nothing check-then-update (sync, so
atomic within a process). Entries expire when `tat < now` (reuse the probabilistic cleanup).
Limitation: state is per process and lost on restart; a restart can allow up to `burst` extra calls.

### 3. Redis plugin: `packages/plugins/ratelimit-redis/src/index.ts`
One Lua script over N keys (`ratelimit:v1:paced:<name>:<key>:<i>`): reads `redis.call('TIME')`
(single clock for all processes), evaluates every bucket, and only if all conform `SET`s the new
`tat` values with `PX` expiry `tat - now + 1000`. Returns `{allowed, retryAfterMs}`. Fail open on
Redis errors with the existing throttled log, like `checkRateLimit`.
With `REDIS_URL` the budget is shared by web + workers and survives restarts; recommended for
daily limits.

### 4. Wrapper: `packages/shared/inferenceRateLimit.ts`
- `ProviderRateLimit` becomes the parsed `{ limits, burst }`; `assertWithinLimit` calls
  `acquirePaced({ name: "<kind>-ratelimit", ... }, "global")`.
- `InferenceRateLimitedError` takes `retryAfterMs` (exact) instead of a fixed-window reset;
  `delayMs = retryAfterMs` + small jitter (0-10%, max 1 s) instead of +0-40%, since pausing
  (step 5) removes the thundering herd. `resetInSeconds` stays for the 429 message
  (`ceil(retryAfterMs / 1000)`).
- Mark it `pauseQueue = true` (new optional property on `QueueRetryAfterError`, default false, so
  the crawler domain limiter is unaffected).
- Factories unchanged except for the config shape; search bypass unchanged.

### 5. Churn fix: pause the runner (`packages/plugins/queue-liteque/src/index.ts`)
liteque's `Runner` dequeues the next job as soon as a slot frees, and a job's timeout starts when
`run()` starts, so waiting inside the job is not viable for multi-minute gaps. Instead:
- `wrappedRun`: on a `QueueRetryAfterError` with `pauseQueue`, set the runner's
  `pausedUntil = now + delayMs` before translating to liteque's `RetryAfterError` (as today).
- Pass `LQRunner` a thin wrapper of the queue whose `attemptDequeue()` returns `null` while
  `now < pausedUntil` (everything else delegates). liteque then just sleeps `pollIntervalMs`
  (1 s): no dequeue, no SQLite writes, no timeouts running.
- Opt-in per runner via a new `RunnerOptions.pauseOnRateLimit?: boolean`, enabled for the inference
  and embeddings workers only. Asset preprocessing keeps the current behaviour, so an LLM-OCR limit
  doesn't stall PDF/image processing that doesn't use the LLM.
- Effect: while limited, one dequeue per slot instead of one per job; when the pause ends, the
  highest-priority job is dequeued first, so new bookmarks go ahead of `QueuePriority.Low` backlog.
- Restate backend: no change (it already delays the job durably); the flag is ignored there.

Known limitation: the embeddings queue also carries cheap `index` jobs (no provider call); they
wait out the pause too (at most one emission interval, ~88 s in the example). Acceptable.

### 6. Summarize endpoint
Unchanged logic; message uses the exact wait (`retry in Ns`).

### 7. Tests
- `packages/shared/ratelimitPacing.test.ts` (GCRA helper + memory plugin via a fake clock):
  burst then spacing; all-or-nothing (a denial updates no bucket); rolling-window property test
  (greedy client over simulated days, assert `<= L` in every window, as in the table above);
  burst clamping.
- `packages/plugins/ratelimit-memory/src/index.test.ts`: `acquirePaced` cases.
- `packages/plugins/ratelimit-redis/src/tests/ratelimit-redis.test.ts`: same cases against Redis
  (Lua path, `TIME`, expiry). These plugin tests need Docker and are **commented out in CI**
  (`ci.yml` "Plugins Tests"); run them locally with Docker, or enable just the rate-limit plugin
  tests in the fork's CI.
- `packages/shared/inferenceRateLimit.test.ts` / `inferenceFactory.test.ts`: update for the new
  config shape; error carries exact delay and `pauseQueue`.
- `packages/plugins/queue-liteque`: test that a paused runner doesn't dequeue until `pausedUntil`,
  resumes with the highest-priority job, and that runners without `pauseOnRateLimit` behave as before.
- Config tests: new vars, legacy pair mapping, burst clamp warning, non-integer rejection.
- Verify each new test fails when its behaviour is removed (as for PR #1).

### 8. Docs
`docs/docs/03-configuration/01-environment-variables.md`: new vars, burst trade-off, rolling-day
semantics, Redis recommendation for daily limits; update this folder's plan with outcomes.

## Rollout for the reported setup

```env
INFERENCE_RATE_LIMIT_PER_MINUTE=20
INFERENCE_RATE_LIMIT_PER_DAY=1000
INFERENCE_RATE_LIMIT_BURST=10
EMBEDDING_RATE_LIMIT_PER_MINUTE=40
EMBEDDING_RATE_LIMIT_PER_DAY=1000
EMBEDDING_RATE_LIMIT_BURST=10
REDIS_URL=redis://redis:6379   # plus a redis service in docker-compose.override.yml
```
(remove the old `*_RATE_LIMIT_WINDOW_MS` / `*_MAX_REQUESTS` lines; they are no longer read)

## Decisions (2026-10-02)

1. Burst is configurable **per kind** (`INFERENCE_RATE_LIMIT_BURST`, `EMBEDDING_RATE_LIMIT_BURST`); default 1.
2. Limits are **not shared**: separate per-minute/hour/day buckets for LLM and for embeddings.
3. **Complete reimplementation**: the PR #1 fixed-window variables and code path are removed, not
   kept for compatibility. `checkRateLimit` (fixed window) remains only for the API rate limiter and
   the crawler domain limiter, which are unrelated.

## Test infrastructure

Plugin tests are not run in CI (`ci.yml` "Plugins Tests" is commented out) and the plugin vitest
config always starts Restate and Redis via Docker. Add:
- `packages/plugins/vitest.unit.config.ts`: no global setup; in-memory limiter and liteque tests.
  Runs locally and in a new CI step.
- `packages/plugins/vitest.redis.config.ts`: Redis global setup only; Redis limiter tests. New CI
  step (GitHub runners have Docker); cannot run in the dev container (no Docker).
The core GCRA maths lives in `packages/shared` so it is tested in the existing CI step.

## Out of scope

- Provider 429 / `Retry-After` handling (option D) — separate follow-up.
- Persisting in-memory limiter state across restarts without Redis.
