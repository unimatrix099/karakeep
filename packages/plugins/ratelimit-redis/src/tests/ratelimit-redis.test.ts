import assert from "assert";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from "vitest";

import { createClient } from "redis";

import { RedisRateLimiter, RedisRateLimitProvider } from "../index";

describe("RedisRateLimiter", () => {
  let rateLimiter: RedisRateLimiter;

  beforeAll(async () => {
    const redisPort = inject("redisPort");
    const provider = new RedisRateLimitProvider({
      url: `redis://localhost:${redisPort}`,
    });
    const client = await provider.getClient();
    assert(client, "Failed to connect to Redis");
    rateLimiter = client as RedisRateLimiter;
  });

  beforeEach(async () => {
    await rateLimiter.clear();
  });

  afterAll(async () => {
    if (rateLimiter) {
      await rateLimiter.disconnect();
    }
  });

  describe("checkRateLimit", () => {
    it("should allow requests within rate limit", async () => {
      const config = {
        name: "test-allow",
        windowMs: 60000,
        maxRequests: 3,
      };

      const result1 = await rateLimiter.checkRateLimit(config, "user1");
      const result2 = await rateLimiter.checkRateLimit(config, "user1");
      const result3 = await rateLimiter.checkRateLimit(config, "user1");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
      expect(result3.allowed).toBe(true);
    });

    it("should block requests exceeding rate limit", async () => {
      const config = {
        name: "test-block",
        windowMs: 60000,
        maxRequests: 2,
      };

      const result1 = await rateLimiter.checkRateLimit(config, "user1");
      const result2 = await rateLimiter.checkRateLimit(config, "user1");
      const result3 = await rateLimiter.checkRateLimit(config, "user1");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
      expect(result3.allowed).toBe(false);
      assert(!result3.allowed);
      expect(result3.resetInSeconds).toBeGreaterThan(0);
    });

    it("should reset after window expires", async () => {
      const config = {
        name: "test-window",
        windowMs: 2000, // 2 second window for faster test
        maxRequests: 1,
      };

      const result1 = await rateLimiter.checkRateLimit(config, "user1");
      expect(result1.allowed).toBe(true);

      const result2 = await rateLimiter.checkRateLimit(config, "user1");
      expect(result2.allowed).toBe(false);

      // Wait for the window to expire
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const result3 = await rateLimiter.checkRateLimit(config, "user1");
      expect(result3.allowed).toBe(true);
    });

    it("should isolate rate limits by key", async () => {
      const config = {
        name: "test-isolate-key",
        windowMs: 60000,
        maxRequests: 1,
      };

      const result1 = await rateLimiter.checkRateLimit(config, "user1:/api/v1");
      const result2 = await rateLimiter.checkRateLimit(config, "user1:/api/v2");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });

    it("should isolate rate limits by config name", async () => {
      const config1 = {
        name: "api-isolate",
        windowMs: 60000,
        maxRequests: 1,
      };
      const config2 = {
        name: "auth-isolate",
        windowMs: 60000,
        maxRequests: 1,
      };

      const result1 = await rateLimiter.checkRateLimit(config1, "user1");
      const result2 = await rateLimiter.checkRateLimit(config2, "user1");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });

    it("should calculate correct resetInSeconds", async () => {
      const config = {
        name: "test-reset-calc",
        windowMs: 60000,
        maxRequests: 1,
      };

      await rateLimiter.checkRateLimit(config, "user1");
      const result = await rateLimiter.checkRateLimit(config, "user1");

      expect(result.allowed).toBe(false);
      assert(!result.allowed);
      expect(result.resetInSeconds).toBeGreaterThan(0);
      expect(result.resetInSeconds).toBeLessThanOrEqual(60);
    });

    it("should allow empty key", async () => {
      const config = {
        name: "test-empty-key",
        windowMs: 60000,
        maxRequests: 1,
      };

      const result = await rateLimiter.checkRateLimit(config, "");
      expect(result.allowed).toBe(true);
    });
  });

  describe("reset", () => {
    it("should reset rate limit for specific identifier", async () => {
      const config = {
        name: "test-reset",
        windowMs: 60000,
        maxRequests: 1,
      };

      await rateLimiter.checkRateLimit(config, "user1");
      const result1 = await rateLimiter.checkRateLimit(config, "user1");
      expect(result1.allowed).toBe(false);

      await rateLimiter.reset(config, "user1");

      const result2 = await rateLimiter.checkRateLimit(config, "user1");
      expect(result2.allowed).toBe(true);
    });

    it("should not affect other identifiers", async () => {
      const config = {
        name: "test-reset-isolation",
        windowMs: 60000,
        maxRequests: 1,
      };

      await rateLimiter.checkRateLimit(config, "user1");
      await rateLimiter.checkRateLimit(config, "user2");

      await rateLimiter.reset(config, "user1");

      const result1 = await rateLimiter.checkRateLimit(config, "user1");
      const result2 = await rateLimiter.checkRateLimit(config, "user2");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(false);
    });
  });

  describe("concurrent access", () => {
    it("should handle concurrent requests atomically", async () => {
      const config = {
        name: "test-concurrent",
        windowMs: 60000,
        maxRequests: 5,
      };

      // Fire 10 requests concurrently
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          rateLimiter.checkRateLimit(config, "user1"),
        ),
      );

      const allowed = results.filter((r) => r.allowed).length;
      const blocked = results.filter((r) => !r.allowed).length;

      expect(allowed).toBe(5);
      expect(blocked).toBe(5);
    });
  });

  describe("acquirePaced", () => {
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    it("allows the burst, then reports the wait for the next slot", async () => {
      // T = ceil(10_000 / (10 - 3 + 1)) = 1250ms
      const config = {
        name: "paced-burst",
        limits: [{ limit: 10, periodMs: 10_000 }],
        burst: 3,
      };
      for (let i = 0; i < 3; i++) {
        expect(await rateLimiter.acquirePaced(config, "global")).toEqual({
          allowed: true,
        });
      }
      const denied = await rateLimiter.acquirePaced(config, "global");
      assert(!denied.allowed);
      expect(denied.retryAfterMs).toBeGreaterThan(1_000);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(1_250);

      await sleep(denied.retryAfterMs + 20);
      expect((await rateLimiter.acquirePaced(config, "global")).allowed).toBe(
        true,
      );
    });

    it("does not consume anything when denied", async () => {
      const config = {
        name: "paced-deny",
        limits: [{ limit: 1, periodMs: 1_000 }],
        burst: 1,
      };
      expect((await rateLimiter.acquirePaced(config, "k")).allowed).toBe(true);
      for (let i = 0; i < 5; i++) {
        expect((await rateLimiter.acquirePaced(config, "k")).allowed).toBe(
          false,
        );
      }
      await sleep(1_050);
      expect((await rateLimiter.acquirePaced(config, "k")).allowed).toBe(true);
    });

    it("requires every limit to allow the request", async () => {
      const config = {
        name: "paced-multi",
        limits: [
          { limit: 5, periodMs: 1_000 }, // T = 200ms
          { limit: 1, periodMs: 60_000 }, // T = 60s
        ],
        burst: 1,
      };
      expect((await rateLimiter.acquirePaced(config, "k")).allowed).toBe(true);
      await sleep(250);
      // The fast bucket would allow it, the slow one doesn't.
      const denied = await rateLimiter.acquirePaced(config, "k");
      assert(!denied.allowed);
      expect(denied.retryAfterMs).toBeGreaterThan(55_000);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
    });

    it("keeps separate state per name and per key", async () => {
      const config = {
        name: "inference-ratelimit",
        limits: [{ limit: 1, periodMs: 60_000 }],
        burst: 1,
      };
      const other = { ...config, name: "embedding-ratelimit" };
      expect((await rateLimiter.acquirePaced(config, "g")).allowed).toBe(true);
      expect((await rateLimiter.acquirePaced(config, "g")).allowed).toBe(false);
      expect((await rateLimiter.acquirePaced(other, "g")).allowed).toBe(true);
      expect((await rateLimiter.acquirePaced(config, "h")).allowed).toBe(true);
    });

    it("is atomic under concurrent requests", async () => {
      const config = {
        name: "paced-concurrent",
        limits: [{ limit: 100, periodMs: 60_000 }],
        burst: 5,
      };
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          rateLimiter.acquirePaced(config, "global"),
        ),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(5);
    });

    it("sets an expiry on its keys and is removed by clear()", async () => {
      const config = {
        name: "paced-ttl",
        limits: [{ limit: 2, periodMs: 10_000 }],
        burst: 1,
      };
      const key = "ratelimit:v1:paced:paced-ttl:k:0";
      const inspector = createClient({
        url: `redis://localhost:${inject("redisPort")}`,
      });
      await inspector.connect();
      try {
        await rateLimiter.acquirePaced(config, "k");
        const pttl = await inspector.pTTL(key);
        expect(pttl).toBeGreaterThan(0);
        // T = 5000ms; expiry is the time until the bucket is idle again + 1s.
        expect(pttl).toBeLessThanOrEqual(6_000);

        await rateLimiter.clear();
        expect(await inspector.exists(key)).toBe(0);
      } finally {
        await inspector.close();
      }
    });

    it("allows everything when no limits are configured", async () => {
      expect(
        await rateLimiter.acquirePaced(
          { name: "paced-none", limits: [], burst: 1 },
          "k",
        ),
      ).toEqual({ allowed: true });
    });
  });
});
