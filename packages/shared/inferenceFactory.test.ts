import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitConfig } from "./ratelimiting";
import serverConfig from "./config";
import {
  EmbeddingClientFactory,
  InferenceClientFactory,
  OpenAIEmbeddingClient,
  OpenAIInferenceClient,
} from "./inference";
import {
  RateLimitedEmbeddingClient,
  RateLimitedInferenceClient,
} from "./inferenceRateLimit";

const rateLimitMocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("./ratelimiting", async (original) => ({
  ...(await original<typeof import("./ratelimiting")>()),
  getRateLimitClient: vi.fn(async () =>
    Promise.resolve({
      checkRateLimit: rateLimitMocks.checkRateLimit,
      reset: vi.fn(),
      clear: vi.fn(),
    }),
  ),
}));

const limit = { windowMs: 60_000, maxRequests: 10 };

const original = {
  inference: { ...serverConfig.inference },
  embedding: { ...serverConfig.embedding },
};

beforeEach(() => {
  Object.assign(serverConfig.inference, original.inference, {
    openAIApiKey: "test-key",
    ollamaBaseUrl: undefined,
    rateLimit: null,
  });
  Object.assign(serverConfig.embedding, original.embedding, {
    openAIApiKey: undefined,
    openAIBaseUrl: undefined,
    rateLimit: null,
  });
  rateLimitMocks.checkRateLimit.mockReset();
  rateLimitMocks.checkRateLimit.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  Object.assign(serverConfig.inference, original.inference);
  Object.assign(serverConfig.embedding, original.embedding);
  vi.restoreAllMocks();
});

describe("InferenceClientFactory", () => {
  it("returns the unwrapped client when no limit is configured", () => {
    const client = InferenceClientFactory.build();
    expect(client).toBeInstanceOf(OpenAIInferenceClient);
  });

  it("wraps the client when the inference limit is configured", () => {
    serverConfig.inference.rateLimit = limit;
    const client = InferenceClientFactory.build();
    expect(client).toBeInstanceOf(RateLimitedInferenceClient);
  });

  it("returns null when no provider is configured", () => {
    serverConfig.inference.openAIApiKey = undefined;
    serverConfig.inference.rateLimit = limit;
    expect(InferenceClientFactory.build()).toBeNull();
  });
});

describe("EmbeddingClientFactory", () => {
  it("returns the unwrapped client when no limit is configured", () => {
    serverConfig.embedding.openAIApiKey = "embedding-key";
    const client = EmbeddingClientFactory.build();
    expect(client).toBeInstanceOf(OpenAIEmbeddingClient);
  });

  it("wraps the client when the embedding limit is configured", () => {
    serverConfig.embedding.openAIApiKey = "embedding-key";
    serverConfig.embedding.rateLimit = limit;
    const client = EmbeddingClientFactory.build();
    expect(client).toBeInstanceOf(RateLimitedEmbeddingClient);
  });

  it("skips the limit when built with rateLimited: false", () => {
    serverConfig.embedding.openAIApiKey = "embedding-key";
    serverConfig.embedding.rateLimit = limit;
    const client = EmbeddingClientFactory.build({ rateLimited: false });
    expect(client).toBeInstanceOf(OpenAIEmbeddingClient);
  });

  it("counts fallback embeddings once, against the embedding limit", async () => {
    // No separate embedding provider: embeddings go through the inference client.
    serverConfig.inference.rateLimit = limit;
    serverConfig.embedding.rateLimit = { windowMs: 30_000, maxRequests: 5 };
    const generate = vi
      .spyOn(OpenAIInferenceClient.prototype, "generateEmbeddingFromText")
      .mockResolvedValue({
        embeddings: [[1]],
        totalTokens: 1,
        promptTokens: 1,
      });

    const client = EmbeddingClientFactory.build();
    expect(client).toBeInstanceOf(RateLimitedEmbeddingClient);
    await client!.generateEmbeddingFromText(["x"]);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(rateLimitMocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(rateLimitMocks.checkRateLimit).toHaveBeenCalledWith(
      {
        name: "embedding-ratelimit",
        windowMs: 30_000,
        maxRequests: 5,
      } satisfies RateLimitConfig,
      "global",
    );
  });
});

describe("rate limit config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function loadConfig(env: Record<string, string>) {
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    vi.resetModules();
    return (await import("./config")).default;
  }

  it("is disabled and warns unless both variables are set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = await loadConfig({
      INFERENCE_RATE_LIMIT_WINDOW_MS: "60000",
      EMBEDDING_RATE_LIMIT_MAX_REQUESTS: "10",
    });
    expect(config.inference.rateLimit).toBeNull();
    expect(config.embedding.rateLimit).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "INFERENCE_RATE_LIMIT_WINDOW_MS and INFERENCE_RATE_LIMIT_MAX_REQUESTS must both be set; inference rate limiting is disabled.",
    );
    expect(warn).toHaveBeenCalledWith(
      "EMBEDDING_RATE_LIMIT_WINDOW_MS and EMBEDDING_RATE_LIMIT_MAX_REQUESTS must both be set; embedding rate limiting is disabled.",
    );
  });

  it("does not warn when neither variable is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await loadConfig({});
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["INFERENCE", "EMBEDDING"])(
    "rejects a non-integer %s_RATE_LIMIT_MAX_REQUESTS",
    async (prefix) => {
      await expect(
        loadConfig({
          [`${prefix}_RATE_LIMIT_WINDOW_MS`]: "60000",
          [`${prefix}_RATE_LIMIT_MAX_REQUESTS`]: "1.5",
        }),
      ).rejects.toThrow(`${prefix}_RATE_LIMIT_MAX_REQUESTS`);
    },
  );

  it("parses both limits when fully configured", async () => {
    const config = await loadConfig({
      INFERENCE_RATE_LIMIT_WINDOW_MS: "60000",
      INFERENCE_RATE_LIMIT_MAX_REQUESTS: "50",
      EMBEDDING_RATE_LIMIT_WINDOW_MS: "1000",
      EMBEDDING_RATE_LIMIT_MAX_REQUESTS: "5",
    });
    expect(config.inference.rateLimit).toEqual({
      windowMs: 60_000,
      maxRequests: 50,
    });
    expect(config.embedding.rateLimit).toEqual({
      windowMs: 1000,
      maxRequests: 5,
    });
  });
});
