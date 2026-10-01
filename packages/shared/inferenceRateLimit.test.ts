import { describe, expect, it, vi } from "vitest";

import type { EmbeddingClient, InferenceClient } from "./inference";
import type {
  RateLimitClient,
  RateLimitConfig,
  RateLimitResult,
} from "./ratelimiting";
import {
  InferenceRateLimitedError,
  RateLimitedEmbeddingClient,
  RateLimitedInferenceClient,
} from "./inferenceRateLimit";
import { QueueRetryAfterError } from "./queueing";

// Simple fixed-window limiter keyed by config name + key.
function makeLimiter(): RateLimitClient {
  const counts = new Map<string, number>();
  return {
    checkRateLimit(config: RateLimitConfig, key: string): RateLimitResult {
      const k = `${config.name}:${key}`;
      const count = counts.get(k) ?? 0;
      if (count >= config.maxRequests) {
        return { allowed: false, resetInSeconds: 30 };
      }
      counts.set(k, count + 1);
      return { allowed: true };
    },
    reset() {
      counts.clear();
    },
    clear() {
      counts.clear();
    },
  };
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

const limit = { windowMs: 60_000, maxRequests: 2 };

describe("RateLimitedInferenceClient", () => {
  it("allows calls up to the limit, then throws without calling the provider", async () => {
    const inner = makeInferenceClient();
    const limiter = makeLimiter();
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
    const rateLimited = error as InferenceRateLimitedError;
    expect(rateLimited.kind).toBe("inference");
    expect(rateLimited.resetInSeconds).toBe(30);
    expect(rateLimited.delayMs).toBeGreaterThanOrEqual(30_000);
    expect(rateLimited.delayMs).toBeLessThanOrEqual(42_000);

    expect(inner.inferFromText).toHaveBeenCalledTimes(1);
    expect(inner.inferFromImage).toHaveBeenCalledTimes(1);
  });

  it("does not count embedding calls against the inference limit", async () => {
    const inner = makeInferenceClient();
    const limiter = makeLimiter();
    const client = new RateLimitedInferenceClient(
      inner,
      { windowMs: 60_000, maxRequests: 1 },
      async () => Promise.resolve(limiter),
    );

    await client.generateEmbeddingFromText(["x"]);
    await client.generateEmbeddingFromText(["y"]);
    await expect(client.inferFromText("a", {})).resolves.toBeDefined();
    expect(inner.generateEmbeddingFromText).toHaveBeenCalledTimes(2);
  });

  it("fails open when no rate limiter is available", async () => {
    const inner = makeInferenceClient();
    const client = new RateLimitedInferenceClient(
      inner,
      { windowMs: 60_000, maxRequests: 1 },
      async () => Promise.resolve(null),
    );

    await client.inferFromText("a", {});
    await client.inferFromText("b", {});
    expect(inner.inferFromText).toHaveBeenCalledTimes(2);
  });
});

describe("RateLimitedEmbeddingClient", () => {
  it("limits embedding calls independently of inference calls", async () => {
    const limiter = makeLimiter();
    const getLimiter = async () => Promise.resolve(limiter);
    const inner = makeInferenceClient();
    const inference = new RateLimitedInferenceClient(inner, limit, getLimiter);
    const embedding: EmbeddingClient = new RateLimitedEmbeddingClient(
      inference,
      limit,
      getLimiter,
    );

    // Exhaust the inference bucket.
    await inference.inferFromText("a", {});
    await inference.inferFromText("b", {});
    await expect(inference.inferFromText("c", {})).rejects.toBeInstanceOf(
      InferenceRateLimitedError,
    );

    // Embedding bucket is still available, and wrapping the (already
    // wrapped) inference client counts each embedding exactly once.
    await embedding.generateEmbeddingFromText(["x"]);
    await embedding.generateEmbeddingFromText(["y"]);
    const error = await embedding
      .generateEmbeddingFromText(["z"])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceRateLimitedError);
    expect((error as InferenceRateLimitedError).kind).toBe("embedding");
    expect(inner.generateEmbeddingFromText).toHaveBeenCalledTimes(2);
  });
});
