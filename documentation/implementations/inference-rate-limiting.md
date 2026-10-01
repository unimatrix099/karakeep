# Plan: rate limiting for LLM and embedding calls

Branch: `feat/inference-rate-limiting` (git identity: unimatrix099 <unimatrix099@github.com>, repo-local)

## Goal
Opt-in, env-configured request-rate limits on inference (chat/vision) and embedding
provider calls, enforced at the client layer so every call site is covered.
Background jobs that hit the limit are rescheduled (not failed, retry budget untouched);
interactive endpoints return 429.

## Key design choice
`InferenceRateLimitedError extends QueueRetryAfterError`. Both queue plugins
(liteque, restate) already translate `QueueRetryAfterError` into a delayed retry that
does not consume attempts, so the worker runners need **no changes**. Only code that
swallows errors needs a rethrow.

## Steps

### 1. Config — `packages/shared/config.ts`
- Add to schema (same shape as `CRAWLER_DOMAIN_RATE_LIMIT_*`):
  - `INFERENCE_RATE_LIMIT_WINDOW_MS`, `INFERENCE_RATE_LIMIT_MAX_REQUESTS` — `z.coerce.number().min(1).optional()`
  - `EMBEDDING_RATE_LIMIT_WINDOW_MS`, `EMBEDDING_RATE_LIMIT_MAX_REQUESTS` — same
- Expose `serverConfig.inference.rateLimit` and `serverConfig.embedding.rateLimit`
  as `{ windowMs, maxRequests } | null` (null unless both vars set).

### 2. Error + wrappers — new `packages/shared/inferenceRateLimit.ts`
- `class InferenceRateLimitedError extends QueueRetryAfterError` (name, `kind: "inference" | "embedding"`,
  `resetInSeconds`; `delayMs` = reset × jitter 1.0–1.4, matching crawler).
- `RateLimitedInferenceClient implements InferenceClient` — wraps an inner client;
  before `inferFromText` / `inferFromImage` calls `checkRateLimit({name: "inference-ratelimit", ...}, "global")`;
  `generateEmbeddingFromText` delegates to the embedding limiter (see below).
- `RateLimitedEmbeddingClient implements EmbeddingClient` — same with `"embedding-ratelimit"`.
- Shared `assertWithinLimit(config, name, kind)` helper. Fail open: no rate-limit plugin
  client → allow (the memory plugin is always registered, so this is a safety net only).

### 3. Factories — `packages/shared/inference.ts`
- `InferenceClientFactory.build()` wraps the result in `RateLimitedInferenceClient` when
  `serverConfig.inference.rateLimit` is set. Its embedding method must use the **embedding**
  limit, not the inference one (the fallback path in `EmbeddingClientFactory.build()` returns
  the inference client).
- `EmbeddingClientFactory.build()` wraps in `RateLimitedEmbeddingClient` when
  `serverConfig.embedding.rateLimit` is set (ensuring no double-wrapping on the fallback path).
- Add an option `EmbeddingClientFactory.build({ rateLimited: false })` for search (step 6).
- As implemented: the inference wrapper passes embedding calls through unlimited, and the
  embedding factory wraps whatever it builds (including the inference-client fallback) with the
  embedding limiter, so each embedding call is counted exactly once, against the embedding bucket.

### 4. Workers — swallowed-error fix only
- `apps/workers/workers/assetPreprocessingWorker.ts:302-307`: the LLM OCR `catch` logs and
  continues. Rethrow if `e instanceof QueueRetryAfterError` so the job is rescheduled instead
  of silently producing no OCR text.
- Audit done: inference (tagging/summarize) and embeddings workers propagate errors already.

### 5. tRPC summarize — `packages/trpc/routers/bookmarks.ts:~1574`
- Catch `InferenceRateLimitedError` → `TRPCError({ code: "TOO_MANY_REQUESTS", message: "AI provider rate limit reached, retry in Ns" })`.
- Check the REST API (`packages/api`) surface maps tRPC `TOO_MANY_REQUESTS` to HTTP 429 (verify existing error mapping).

### 6. Semantic search query embeddings — `bookmarks.ts:~1043`
- **Decided: bypass the limit** (`EmbeddingClientFactory.build({ rateLimited: false })`).
  The limits exist to pace background batch work (crawl → tag/summarize/embed); a search
  is one small, user-facing call and must not be starved by indexing.

### 7. Tests (Vitest)
- `packages/shared/inferenceRateLimit.test.ts`:
  - allows up to N calls in a window, Nth+1 throws `InferenceRateLimitedError`,
    which is `instanceof QueueRetryAfterError` with `delayMs >= resetInSeconds*1000`.
  - inference and embedding buckets are independent.
  - inner client is not called when limited.
  - no limit configured → factories return the unwrapped client.
  - fallback embedding path (no separate embedding provider) uses the embedding bucket.
  - Use the in-memory `RateLimiter` from `@karakeep/plugins/ratelimit-memory` registered via
    `PluginManager`, or a stub `RateLimitClient` (whichever fits package deps — shared must not
    depend on plugins; prefer a stub).
- Add assetPreprocessing rethrow test if a test harness exists for it; otherwise covered by review.

### 8. Docs — `docs/docs/03-configuration/01-environment-variables.md`
- Add the four vars next to `INFERENCE_NUM_WORKERS` / `EMBEDDING_NUM_WORKERS`.
- Note: without `REDIS_URL` the limit is per process (web and workers each get the full budget);
  with Redis it is global. Memory limiter is fixed-window (bursts up to 2× at boundaries).

### 9. Verify
- `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm --filter @karakeep/shared test`.
- Manual: run workers with `INFERENCE_RATE_LIMIT_MAX_REQUESTS=1 INFERENCE_RATE_LIMIT_WINDOW_MS=60000`,
  add 3 bookmarks, confirm log lines show rescheduling and all three eventually get tagged.

## Out of scope (possible follow-ups)
- `INFERENCE_MAX_RETRIES` passthrough to the OpenAI SDK, and converting exhausted provider
  429s (honouring `retry-after`) into `QueueRetryAfterError`.
- Tokens-per-minute limiting.
- Per-user buckets (the key is `"global"` for now; the wrapper makes adding `userId` easy later).

## Commit plan
Single commit (or two: feature + docs), authored as unimatrix099, only after approval.
