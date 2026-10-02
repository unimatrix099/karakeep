import type {
  EmbeddingClient,
  EmbeddingResponse,
  InferenceClient,
  InferenceOptions,
  InferenceResponse,
} from "./inference";
import type { PacedLimit, RateLimitClient } from "./ratelimiting";
import logger from "./logger";
import { QueueRetryAfterError } from "./queueing";
import { getRateLimitClient } from "./ratelimiting";

export interface ProviderRateLimit {
  limits: PacedLimit[];
  burst: number;
}

type RateLimitKind = "inference" | "embedding";

type RateLimitClientGetter = () => Promise<RateLimitClient | null>;

/**
 * Thrown when a provider call is rejected by the configured rate limit.
 * Extends QueueRetryAfterError so that queue runners reschedule the job after
 * `delayMs` without counting it against the job's retry attempts, and asks
 * the runner to pause dequeuing until then.
 */
export class InferenceRateLimitedError extends QueueRetryAfterError {
  public readonly resetInSeconds: number;

  constructor(
    public readonly kind: RateLimitKind,
    public readonly retryAfterMs: number,
  ) {
    const resetInSeconds = Math.ceil(retryAfterMs / 1000);
    // The paced limiter reports the exact wait and the paused queue avoids a
    // thundering herd, so only a little jitter is needed: up to 10%, max 1s.
    const jitterMs = Math.min(retryAfterMs * 0.1, 1000) * Math.random();
    super(
      `${kind} rate limit reached, retry in ${resetInSeconds}s`,
      Math.floor(retryAfterMs + jitterMs),
      { pauseQueue: true },
    );
    this.name = "InferenceRateLimitedError";
    this.resetInSeconds = resetInSeconds;
  }
}

async function assertWithinLimit(
  kind: RateLimitKind,
  limit: ProviderRateLimit,
  getClient: RateLimitClientGetter,
): Promise<void> {
  const client = await getClient();
  if (!client) {
    // No rate limiter available, fail open.
    return;
  }
  const result = await client.acquirePaced(
    { name: `${kind}-ratelimit`, limits: limit.limits, burst: limit.burst },
    "global",
  );
  if (!result.allowed) {
    const error = new InferenceRateLimitedError(kind, result.retryAfterMs);
    logger.info(
      `[${kind}] Rate limit reached, next slot in ${(error.delayMs / 1000).toFixed(2)} seconds.`,
    );
    throw error;
  }
}

/**
 * Applies the inference rate limit to text and image calls. Embedding calls
 * are passed through untouched; they are limited by RateLimitedEmbeddingClient.
 */
export class RateLimitedInferenceClient implements InferenceClient {
  constructor(
    private readonly inner: InferenceClient,
    private readonly limit: ProviderRateLimit,
    private readonly getClient: RateLimitClientGetter = getRateLimitClient,
  ) {}

  async inferFromText(
    prompt: string,
    opts: Partial<InferenceOptions>,
  ): Promise<InferenceResponse> {
    await assertWithinLimit("inference", this.limit, this.getClient);
    return this.inner.inferFromText(prompt, opts);
  }

  async inferFromImage(
    prompt: string,
    contentType: string,
    image: string,
    opts: Partial<InferenceOptions>,
  ): Promise<InferenceResponse> {
    await assertWithinLimit("inference", this.limit, this.getClient);
    return this.inner.inferFromImage(prompt, contentType, image, opts);
  }

  generateEmbeddingFromText(inputs: string[]): Promise<EmbeddingResponse> {
    return this.inner.generateEmbeddingFromText(inputs);
  }
}

export class RateLimitedEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly inner: EmbeddingClient,
    private readonly limit: ProviderRateLimit,
    private readonly getClient: RateLimitClientGetter = getRateLimitClient,
  ) {}

  async generateEmbeddingFromText(
    inputs: string[],
  ): Promise<EmbeddingResponse> {
    await assertWithinLimit("embedding", this.limit, this.getClient);
    return this.inner.generateEmbeddingFromText(inputs);
  }
}
