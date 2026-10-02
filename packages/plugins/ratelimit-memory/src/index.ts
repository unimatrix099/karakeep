import type {
  PacedRateLimitConfig,
  PacedRateLimitResult,
  RateLimitClient,
  RateLimitConfig,
  RateLimitResult,
} from "@karakeep/shared/ratelimiting";
import { PluginProvider } from "@karakeep/shared/plugins";
import { evaluateGcra, gcraParams } from "@karakeep/shared/ratelimitPacing";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export class RateLimiter implements RateLimitClient {
  private store = new Map<string, RateLimitEntry>();
  // Theoretical arrival time per paced bucket ("name:key:limitIndex").
  private pacedStore = new Map<string, number>();
  private cleanupProbability: number;

  constructor(cleanupProbability = 0.01) {
    // Probability of cleanup on each check (default 1%)
    this.cleanupProbability = cleanupProbability;
  }

  private cleanupExpiredEntries() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.resetTime) {
        this.store.delete(key);
      }
    }
    for (const [key, tat] of this.pacedStore.entries()) {
      // A bucket whose arrival time has passed holds no information.
      if (tat <= now) {
        this.pacedStore.delete(key);
      }
    }
  }

  get size(): number {
    return this.store.size + this.pacedStore.size;
  }

  acquirePaced(
    config: PacedRateLimitConfig,
    key: string,
  ): PacedRateLimitResult {
    if (!key || config.limits.length === 0) {
      return { allowed: true };
    }

    if (Math.random() < this.cleanupProbability) {
      this.cleanupExpiredEntries();
    }

    const keys = config.limits.map(
      (_, i) => `paced:${config.name}:${key}:${i}`,
    );
    const result = evaluateGcra(
      keys.map((k) => this.pacedStore.get(k)),
      config.limits.map((l) => gcraParams(l, config.burst)),
      Date.now(),
    );
    if (!result.allowed) {
      return result;
    }
    result.tats.forEach((tat, i) => this.pacedStore.set(keys[i], tat));
    return { allowed: true };
  }

  checkRateLimit(config: RateLimitConfig, key: string): RateLimitResult {
    if (!key) {
      return { allowed: true };
    }

    // Probabilistic cleanup
    if (Math.random() < this.cleanupProbability) {
      this.cleanupExpiredEntries();
    }

    const rateLimitKey = `${config.name}:${key}`;
    const now = Date.now();

    let entry = this.store.get(rateLimitKey);

    if (!entry || now > entry.resetTime) {
      entry = {
        count: 1,
        resetTime: now + config.windowMs,
      };
      this.store.set(rateLimitKey, entry);
      return { allowed: true };
    }

    if (entry.count >= config.maxRequests) {
      const resetInSeconds = Math.ceil((entry.resetTime - now) / 1000);
      return {
        allowed: false,
        resetInSeconds,
      };
    }

    entry.count++;
    return { allowed: true };
  }

  reset(config: RateLimitConfig, key: string) {
    const rateLimitKey = `${config.name}:${key}`;
    this.store.delete(rateLimitKey);
  }

  clear() {
    this.store.clear();
    this.pacedStore.clear();
  }
}

export class RateLimitProvider implements PluginProvider<RateLimitClient> {
  private client: RateLimiter | null = null;

  async getClient(): Promise<RateLimitClient | null> {
    if (!this.client) {
      this.client = new RateLimiter();
    }
    return this.client;
  }
}
