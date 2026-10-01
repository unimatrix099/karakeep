import type {
  EmbeddingClient,
  EmbeddingResponse,
  InferenceClient,
  InferenceOptions,
  InferenceResponse,
} from "./inference";
import type { RateLimitClient } from "./ratelimiting";
import logger from "./logger";
import { QueueRetryAfterError } from "./queueing";
import { getRateLimitClient } from "./ratelimiting";

export interface ProviderRateLimit {
  windowMs: number;
  maxRequests: number;
}

type RateLimitKind = "inference" | "embedding";

type RateLimitClientGetter = () => Promise<RateLimitClient | null>;

/**
 * Thrown when a provider call is rejected by the configured rate limit.
 * Extends QueueRetryAfterError so that queue runners reschedule the job after
 * `delayMs` without counting it against the job's retry attempts.
 */
export class InferenceRateLimitedError extends QueueRetryAfterError {
  constructor(
    public readonly kind: RateLimitKind,
    public readonly resetInSeconds: number,
  ) {
    // Add jitter to prevent thundering herd: +40% random variation
    const jitterFactor = 1.0 + Math.random() * 0.4;
    super(
      `${kind} rate limit reached, retry in ${resetInSeconds}s`,
      Math.floor(Math.max(resetInSeconds, 1) * 1000 * jitterFactor),
    );
    this.name = "InferenceRateLimitedError";
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
  const result = await client.checkRateLimit(
    {
      name: `${kind}-ratelimit`,
      windowMs: limit.windowMs,
      maxRequests: limit.maxRequests,
    },
    "global",
  );
  if (!result.allowed) {
    const error = new InferenceRateLimitedError(kind, result.resetInSeconds);
    logger.info(
      `[${kind}] Rate limit reached, retrying in ${(error.delayMs / 1000).toFixed(2)} seconds (with jitter).`,
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
