import { describe, expect, it, vi } from "vitest";

import type { EmbeddingClient, InferenceClient } from "./inference";
import type {
  PacedRateLimitConfig,
  PacedRateLimitResult,
  RateLimitClient,
} from "./ratelimiting";
import {
  InferenceRateLimitedError,
  RateLimitedEmbeddingClient,
  RateLimitedInferenceClient,
} from "./inferenceRateLimit";
import { QueueRetryAfterError } from "./queueing";

// Allows `allowance` calls per config name, then denies with a fixed wait.
function makeLimiter(allowance: number, retryAfterMs = 30_000) {
  const counts = new Map<string, number>();
  const acquirePaced = vi.fn(
    (config: PacedRateLimitConfig, key: string): PacedRateLimitResult => {
      const k = `${config.name}:${key}`;
      const count = counts.get(k) ?? 0;
      if (count >= allowance) {
        return { allowed: false, retryAfterMs };
      }
      counts.set(k, count + 1);
      return { allowed: true };
    },
  );
  const limiter: RateLimitClient = {
    checkRateLimit: vi.fn(),
    acquirePaced,
    reset: vi.fn(),
    clear: vi.fn(),
  };
  return { limiter, acquirePaced };
}

function makeInferenceClient() {
  return {
    inferFromText: vi.fn(async () => ({ response: "text", totalTokens: 1 })),
    inferFromImage: vi.fn(async () => ({ response: "image", totalTokens: 1 })),
    generateEmbeddingFromText: vi.fn(async () => ({
      embeddings: [[1]],
      totalTokens: 1,
      promptTokens: 1,
    })),
  } satisfies InferenceClient;
}

const limit = {
  limits: [
    { limit: 20, periodMs: 60_000 },
    { limit: 1000, periodMs: 86_400_000 },
  ],
  burst: 10,
};

describe("RateLimitedInferenceClient", () => {
  it("checks the paced limit with the configured limits and burst", async () => {
    const { limiter, acquirePaced } = makeLimiter(10);
    const client = new RateLimitedInferenceClient(
      makeInferenceClient(),
      limit,
      async () => Promise.resolve(limiter),
    );

    await client.inferFromText("a", {});
    expect(acquirePaced).toHaveBeenCalledWith(
      { name: "inference-ratelimit", ...limit },
      "global",
    );
  });

  it("calls the provider while allowed, then throws without calling it", async () => {
    const inner = makeInferenceClient();
    const { limiter } = makeLimiter(2);
    const client = new RateLimitedInferenceClient(inner, limit, async () =>
      Promise.resolve(limiter),
    );

    await expect(client.inferFromText("a", {})).resolves.toMatchObject({
      response: "text",
    });
    await expect(
      client.inferFromImage("b", "image/png", "data", {}),
    ).resolves.toMatchObject({ response: "image" });

    const error = await client.inferFromText("c", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceRateLimitedError);
    expect(error).toBeInstanceOf(QueueRetryAfterError);
    expect(inner.inferFromText).toHaveBeenCalledTimes(1);
    expect(inner.inferFromImage).toHaveBeenCalledTimes(1);
  });

  it("reports the exact wait with at most 10% / 1s of jitter and pauses the queue", async () => {
    const { limiter } = makeLimiter(0, 30_000);
    const client = new RateLimitedInferenceClient(
      makeInferenceClient(),
      limit,
      async () => Promise.resolve(limiter),
    );

    for (let i = 0; i < 20; i++) {
      const error = (await client
        .inferFromText("a", {})
        .catch((e: unknown) => e)) as InferenceRateLimitedError;
      expect(error.kind).toBe("inference");
      expect(error.retryAfterMs).toBe(30_000);
      expect(error.resetInSeconds).toBe(30);
      expect(error.pauseQueue).toBe(true);
      expect(error.delayMs).toBeGreaterThanOrEqual(30_000);
      expect(error.delayMs).toBeLessThanOrEqual(31_000);
    }
  });

  it("keeps the jitter proportional for short waits", async () => {
    const { limiter } = makeLimiter(0, 1_500);
    const client = new RateLimitedInferenceClient(
      makeInferenceClient(),
      limit,
      async () => Promise.resolve(limiter),
    );
    const error = (await client
      .inferFromText("a", {})
      .catch((e: unknown) => e)) as InferenceRateLimitedError;
    // ceil(1.5s) for the user-facing message, <= 10% jitter on the delay.
    expect(error.resetInSeconds).toBe(2);
    expect(error.message).toBe("inference rate limit reached, retry in 2s");
    expect(error.delayMs).toBeGreaterThanOrEqual(1_500);
    expect(error.delayMs).toBeLessThanOrEqual(1_650);
  });

  it("does not count embedding calls against the inference limit", async () => {
    const inner = makeInferenceClient();
    const { limiter, acquirePaced } = makeLimiter(1);
    const client = new RateLimitedInferenceClient(inner, limit, async () =>
      Promise.resolve(limiter),
    );

    await client.generateEmbeddingFromText(["x"]);
    await client.generateEmbeddingFromText(["y"]);
    expect(acquirePaced).not.toHaveBeenCalled();
    await expect(client.inferFromText("a", {})).resolves.toBeDefined();
    expect(inner.generateEmbeddingFromText).toHaveBeenCalledTimes(2);
  });

  it("fails open when no rate limiter is available", async () => {
    const inner = makeInferenceClient();
    const client = new RateLimitedInferenceClient(inner, limit, async () =>
      Promise.resolve(null),
    );

    await client.inferFromText("a", {});
    await client.inferFromText("b", {});
    expect(inner.inferFromText).toHaveBeenCalledTimes(2);
  });
});

describe("RateLimitedEmbeddingClient", () => {
  it("limits embedding calls in their own bucket, counting each once", async () => {
    const { limiter, acquirePaced } = makeLimiter(2);
    const getLimiter = async () => Promise.resolve(limiter);
    const inner = makeInferenceClient();
    const inference = new RateLimitedInferenceClient(inner, limit, getLimiter);
    const embeddingLimit = {
      limits: [{ limit: 40, periodMs: 60_000 }],
      burst: 5,
    };
    const embedding: EmbeddingClient = new RateLimitedEmbeddingClient(
      inference,
      embeddingLimit,
      getLimiter,
    );

    // Exhaust the inference bucket.
    await inference.inferFromText("a", {});
    await inference.inferFromText("b", {});
    await expect(inference.inferFromText("c", {})).rejects.toBeInstanceOf(
      InferenceRateLimitedError,
    );

    // The embedding bucket is still available.
    await embedding.generateEmbeddingFromText(["x"]);
    await embedding.generateEmbeddingFromText(["y"]);
    const error = await embedding
      .generateEmbeddingFromText(["z"])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceRateLimitedError);
    expect((error as InferenceRateLimitedError).kind).toBe("embedding");
    expect(inner.generateEmbeddingFromText).toHaveBeenCalledTimes(2);
    expect(acquirePaced).toHaveBeenCalledWith(
      { name: "embedding-ratelimit", ...embeddingLimit },
      "global",
    );
  });
});

describe("QueueRetryAfterError", () => {
  it("does not pause the queue unless asked to", () => {
    expect(new QueueRetryAfterError("x", 10).pauseQueue).toBe(false);
    expect(
      new QueueRetryAfterError("x", 10, { pauseQueue: true }).pauseQueue,
    ).toBe(true);
  });
});
