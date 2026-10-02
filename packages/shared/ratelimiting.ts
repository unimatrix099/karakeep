import type {
  PacedRateLimitConfig,
  PacedRateLimitResult,
} from "./ratelimitPacing";
import { PluginManager, PluginType } from "./plugins";

export type {
  PacedLimit,
  PacedRateLimitConfig,
  PacedRateLimitResult,
} from "./ratelimitPacing";

export interface RateLimitConfig {
  name: string;
  windowMs: number;
  maxRequests: number;
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; resetInSeconds: number };

export interface RateLimitClient {
  /**
   * Check if a request should be allowed based on rate limiting rules
   * @param config Rate limit configuration
   * @param key Unique rate limiting key (e.g., "ip:127.0.0.1:path:/api/v1")
   * @returns Result indicating if the request is allowed and reset time if not
   */
  checkRateLimit(
    config: RateLimitConfig,
    key: string,
  ): RateLimitResult | Promise<RateLimitResult>;

  /**
   * Paced (token-bucket) rate limiting: allows the request only if every
   * limit in `config.limits` allows it, spacing requests evenly with up to
   * `config.burst` back-to-back. A denial consumes nothing and reports how
   * long to wait.
   * @param config Paced limit configuration
   * @param key Unique rate limiting key
   */
  acquirePaced(
    config: PacedRateLimitConfig,
    key: string,
  ): PacedRateLimitResult | Promise<PacedRateLimitResult>;

  /**
   * Reset rate limit for a specific key
   * @param config Rate limit configuration
   * @param key Unique rate limiting key
   */
  reset(config: RateLimitConfig, key: string): void | Promise<void>;

  /**
   * Clear all rate limit entries
   */
  clear(): void | Promise<void>;
}

export async function getRateLimitClient(): Promise<RateLimitClient | null> {
  return PluginManager.getClient(PluginType.RateLimit);
}
