// Paced rate limiting using GCRA (the single-value form of a token bucket).
//
// Each "limit requests per periodMs" becomes one bucket. With a burst of b,
// requests are spaced emissionMs = ceil(periodMs / (limit - b + 1)) apart and
// up to b may be sent back-to-back after an idle period. In any rolling window
// shorter than periodMs at most floor(window / emissionMs) + b <= limit
// requests conform, so the limit holds in every window. All arithmetic is in
// whole milliseconds and rounds the spacing up, so it never errs on the
// permissive side.

export interface PacedLimit {
  limit: number;
  periodMs: number;
}

export interface PacedRateLimitConfig {
  name: string;
  limits: PacedLimit[];
  burst: number;
}

export type PacedRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export interface GcraParams {
  emissionMs: number;
  toleranceMs: number;
}

export function gcraParams(limit: PacedLimit, burst: number): GcraParams {
  const b = Math.min(Math.max(Math.floor(burst), 1), limit.limit);
  const emissionMs = Math.ceil(limit.periodMs / (limit.limit - b + 1));
  return { emissionMs, toleranceMs: (b - 1) * emissionMs };
}

/**
 * Evaluates one request against every bucket. `tats` holds each bucket's
 * theoretical arrival time (undefined when the bucket has no state). The
 * request is allowed only if every bucket allows it; in that case the new
 * arrival times are returned for the caller to store. A denial returns the
 * wait until all buckets would allow it and must not change any state.
 */
export function evaluateGcra(
  tats: readonly (number | undefined)[],
  params: readonly GcraParams[],
  now: number,
): { allowed: true; tats: number[] } | { allowed: false; retryAfterMs: number } {
  let retryAfterMs = 0;
  const effectiveTats = params.map((_, i) => Math.max(tats[i] ?? now, now));
  params.forEach((p, i) => {
    const wait = effectiveTats[i] - p.toleranceMs - now;
    retryAfterMs = Math.max(retryAfterMs, wait);
  });
  if (retryAfterMs > 0) {
    return { allowed: false, retryAfterMs };
  }
  return {
    allowed: true,
    tats: effectiveTats.map((tat, i) => tat + params[i].emissionMs),
  };
}
