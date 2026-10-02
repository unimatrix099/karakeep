import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PacedRateLimitConfig } from "./ratelimiting";
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
  acquirePaced: vi.fn(),
}));

vi.mock("./ratelimiting", async (original) => ({
  ...(await original<typeof import("./ratelimiting")>()),
  getRateLimitClient: vi.fn(async () =>
    Promise.resolve({
      checkRateLimit: vi.fn(),
      acquirePaced: rateLimitMocks.acquirePaced,
      reset: vi.fn(),
      clear: vi.fn(),
    }),
  ),
}));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const limit = { limits: [{ limit: 10, periodMs: MINUTE }], burst: 1 };

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
  rateLimitMocks.acquirePaced.mockReset();
  rateLimitMocks.acquirePaced.mockResolvedValue({ allowed: true });
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
    serverConfig.embedding.rateLimit = {
      limits: [{ limit: 40, periodMs: MINUTE }],
      burst: 5,
    };
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
    expect(rateLimitMocks.acquirePaced).toHaveBeenCalledTimes(1);
    expect(rateLimitMocks.acquirePaced).toHaveBeenCalledWith(
      {
        name: "embedding-ratelimit",
        limits: [{ limit: 40, periodMs: MINUTE }],
        burst: 5,
      } satisfies PacedRateLimitConfig,
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

  function silenceWarnings() {
    return vi.spyOn(console, "warn").mockImplementation(() => undefined);
  }

  it("is disabled, without warnings, when nothing is set", async () => {
    const warn = silenceWarnings();
    const config = await loadConfig({});
    expect(config.inference.rateLimit).toBeNull();
    expect(config.embedding.rateLimit).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("parses per-minute, per-hour and per-day limits separately for each kind", async () => {
    const config = await loadConfig({
      INFERENCE_RATE_LIMIT_PER_MINUTE: "20",
      INFERENCE_RATE_LIMIT_PER_DAY: "1000",
      INFERENCE_RATE_LIMIT_BURST: "10",
      EMBEDDING_RATE_LIMIT_PER_MINUTE: "40",
      EMBEDDING_RATE_LIMIT_PER_HOUR: "500",
      EMBEDDING_RATE_LIMIT_PER_DAY: "900",
      EMBEDDING_RATE_LIMIT_BURST: "5",
    });
    expect(config.inference.rateLimit).toEqual({
      limits: [
        { limit: 20, periodMs: MINUTE },
        { limit: 1000, periodMs: DAY },
      ],
      burst: 10,
    });
    expect(config.embedding.rateLimit).toEqual({
      limits: [
        { limit: 40, periodMs: MINUTE },
        { limit: 500, periodMs: 60 * MINUTE },
        { limit: 900, periodMs: DAY },
      ],
      burst: 5,
    });
  });

  it("configures one kind without affecting the other", async () => {
    const config = await loadConfig({ EMBEDDING_RATE_LIMIT_PER_DAY: "1000" });
    expect(config.inference.rateLimit).toBeNull();
    expect(config.embedding.rateLimit).toEqual({
      limits: [{ limit: 1000, periodMs: DAY }],
      burst: 1,
    });
  });

  it("defaults the burst to 1", async () => {
    const config = await loadConfig({ INFERENCE_RATE_LIMIT_PER_MINUTE: "20" });
    expect(config.inference.rateLimit?.burst).toBe(1);
  });

  it("clamps the burst to the smallest limit and warns", async () => {
    const warn = silenceWarnings();
    const config = await loadConfig({
      INFERENCE_RATE_LIMIT_PER_MINUTE: "20",
      INFERENCE_RATE_LIMIT_PER_DAY: "1000",
      INFERENCE_RATE_LIMIT_BURST: "50",
    });
    expect(config.inference.rateLimit?.burst).toBe(20);
    expect(warn).toHaveBeenCalledWith(
      "INFERENCE_RATE_LIMIT_BURST (50) is larger than the smallest configured limit (20); using 20.",
    );
  });

  it("ignores a burst without any limit and warns", async () => {
    const warn = silenceWarnings();
    const config = await loadConfig({ EMBEDDING_RATE_LIMIT_BURST: "10" });
    expect(config.embedding.rateLimit).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "EMBEDDING_RATE_LIMIT_BURST is set but no EMBEDDING_RATE_LIMIT_PER_MINUTE/PER_HOUR/PER_DAY limit is; embedding rate limiting is disabled.",
    );
  });

  it.each(["INFERENCE", "EMBEDDING"])(
    "warns that the removed %s fixed-window variables are no longer read",
    async (prefix) => {
      const warn = silenceWarnings();
      const config = await loadConfig({
        [`${prefix}_RATE_LIMIT_WINDOW_MS`]: "60000",
        [`${prefix}_RATE_LIMIT_MAX_REQUESTS`]: "10",
      });
      expect(config.inference.rateLimit).toBeNull();
      expect(config.embedding.rateLimit).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        `${prefix}_RATE_LIMIT_WINDOW_MS and ${prefix}_RATE_LIMIT_MAX_REQUESTS are no longer supported and are ignored; use ${prefix}_RATE_LIMIT_PER_MINUTE/PER_HOUR/PER_DAY and ${prefix}_RATE_LIMIT_BURST instead.`,
      );
    },
  );

  it.each([
    ["INFERENCE_RATE_LIMIT_PER_MINUTE", "1.5"],
    ["INFERENCE_RATE_LIMIT_PER_HOUR", "0"],
    ["EMBEDDING_RATE_LIMIT_PER_DAY", "-3"],
    ["EMBEDDING_RATE_LIMIT_BURST", "2.5"],
    ["INFERENCE_RATE_LIMIT_BURST", "0"],
  ])("rejects an invalid %s (%s)", async (name, value) => {
    await expect(
      loadConfig({ INFERENCE_RATE_LIMIT_PER_DAY: "100", [name]: value }),
    ).rejects.toThrow(name);
  });
});
