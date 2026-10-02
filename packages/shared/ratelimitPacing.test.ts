import { describe, expect, it } from "vitest";

import type { GcraParams, PacedLimit } from "./ratelimitPacing";
import { evaluateGcra, gcraParams } from "./ratelimitPacing";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function perMinute(limit: number): PacedLimit {
  return { limit, periodMs: MINUTE };
}

function perDay(limit: number): PacedLimit {
  return { limit, periodMs: DAY };
}

// A greedy client that sends a request as soon as every bucket allows it.
// Returns the send timestamps (ms) within [0, horizonMs).
function simulateGreedy(
  limits: PacedLimit[],
  burst: number,
  horizonMs: number,
): number[] {
  const params = limits.map((l) => gcraParams(l, burst));
  let tats: (number | undefined)[] = limits.map(() => undefined);
  const sent: number[] = [];
  let now = 0;
  while (now < horizonMs) {
    const result = evaluateGcra(tats, params, now);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
      now += result.retryAfterMs;
      continue;
    }
    tats = result.tats;
    sent.push(now);
  }
  return sent;
}

// Max number of sends inside any half-open window [t, t + windowMs).
function maxInAnyWindow(sent: number[], windowMs: number): number {
  let max = 0;
  let end = 0;
  for (let start = 0; start < sent.length; start++) {
    while (end < sent.length && sent[end] < sent[start] + windowMs) {
      end++;
    }
    max = Math.max(max, end - start);
  }
  return max;
}

describe("gcraParams", () => {
  it("spaces requests evenly with a burst of 1", () => {
    expect(gcraParams(perDay(1000), 1)).toEqual({
      emissionMs: 86_400,
      toleranceMs: 0,
    });
  });

  it("widens the spacing to make room for the burst", () => {
    // ceil(86_400_000 / (1000 - 10 + 1)) = 87_185
    expect(gcraParams(perDay(1000), 10)).toEqual({
      emissionMs: 87_185,
      toleranceMs: 9 * 87_185,
    });
  });

  it("rounds the spacing up to whole milliseconds", () => {
    // 60_000 / 7 = 8571.43 -> 8572
    expect(gcraParams({ limit: 7, periodMs: MINUTE }, 1).emissionMs).toBe(
      8572,
    );
  });

  it("clamps the burst to the limit", () => {
    expect(gcraParams(perMinute(5), 50)).toEqual(gcraParams(perMinute(5), 5));
  });

  it("treats a burst below 1 as 1", () => {
    expect(gcraParams(perMinute(5), 0)).toEqual(gcraParams(perMinute(5), 1));
  });
});

describe("evaluateGcra", () => {
  it("allows the first request and records the next arrival time", () => {
    const params = [gcraParams(perMinute(6), 1)]; // one every 10s
    const result = evaluateGcra([undefined], params, 1_000);
    expect(result).toEqual({ allowed: true, tats: [11_000] });
  });

  it("allows `burst` requests at once, then waits exactly one interval", () => {
    const params = [gcraParams(perMinute(20), 5)]; // T = ceil(60000/16) = 3750
    let tats: (number | undefined)[] = [undefined];
    for (let i = 0; i < 5; i++) {
      const result = evaluateGcra(tats, params, 0);
      expect(result.allowed).toBe(true);
      if (result.allowed) tats = result.tats;
    }
    const denied = evaluateGcra(tats, params, 0);
    expect(denied).toEqual({ allowed: false, retryAfterMs: 3_750 });

    expect(evaluateGcra(tats, params, 3_749).allowed).toBe(false);
    expect(evaluateGcra(tats, params, 3_750).allowed).toBe(true);
  });

  it("refills the burst after an idle period", () => {
    const params = [gcraParams(perMinute(20), 3)];
    let tats: (number | undefined)[] = [undefined];
    for (let i = 0; i < 3; i++) {
      const r = evaluateGcra(tats, params, 0);
      if (r.allowed) tats = r.tats;
    }
    expect(evaluateGcra(tats, params, 0).allowed).toBe(false);

    // After a long pause, a full burst is available again.
    const later = 10 * MINUTE;
    for (let i = 0; i < 3; i++) {
      const r = evaluateGcra(tats, params, later);
      expect(r.allowed).toBe(true);
      if (r.allowed) tats = r.tats;
    }
    expect(evaluateGcra(tats, params, later).allowed).toBe(false);
  });

  it("requires every limit to allow the request and reports the longest wait", () => {
    const params: GcraParams[] = [
      gcraParams(perMinute(20), 1), // T = 3000
      gcraParams(perDay(1000), 1), // T = 86_400
    ];
    const first = evaluateGcra([undefined, undefined], params, 0);
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    // 3s later the minute bucket allows it, but the day bucket doesn't.
    const second = evaluateGcra(first.tats, params, 3_000);
    expect(second).toEqual({ allowed: false, retryAfterMs: 83_400 });
  });

  it("is all-or-nothing: a denial returns no new state", () => {
    const params = [gcraParams(perMinute(1), 1)];
    const result = evaluateGcra([30_000], params, 0);
    expect(result).toEqual({ allowed: false, retryAfterMs: 30_000 });
    expect(result).not.toHaveProperty("tats");
  });

  it("ignores state from the past", () => {
    const params = [gcraParams(perMinute(6), 1)];
    expect(evaluateGcra([5_000], params, 100_000)).toEqual({
      allowed: true,
      tats: [110_000],
    });
  });
});

describe("rolling-window guarantee (greedy client, 3 simulated days)", () => {
  const cases: { name: string; limits: PacedLimit[]; burst: number }[] = [
    { name: "20/min + 1000/day, burst 1", limits: [perMinute(20), perDay(1000)], burst: 1 },
    { name: "20/min + 1000/day, burst 10", limits: [perMinute(20), perDay(1000)], burst: 10 },
    { name: "20/min + 1000/day, burst 20", limits: [perMinute(20), perDay(1000)], burst: 20 },
    { name: "40/min + 1000/day, burst 10", limits: [perMinute(40), perDay(1000)], burst: 10 },
    { name: "7/min + 100/hour, burst 3", limits: [perMinute(7), { limit: 100, periodMs: HOUR }], burst: 3 },
    { name: "20/min only, burst 5", limits: [perMinute(20)], burst: 5 },
  ];

  it.each(cases)("$name never exceeds any limit", ({ limits, burst }) => {
    const sent = simulateGreedy(limits, burst, 3 * DAY);
    for (const { limit, periodMs } of limits) {
      expect(maxInAnyWindow(sent, periodMs)).toBeLessThanOrEqual(limit);
    }
  });

  it("sends the burst immediately", () => {
    const sent = simulateGreedy([perMinute(20), perDay(1000)], 10, DAY);
    expect(sent.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 0));
    expect(sent[10]).toBeGreaterThan(0);
  });

  it("uses almost all of the binding daily budget", () => {
    const sent = simulateGreedy([perMinute(20), perDay(1000)], 10, 3 * DAY);
    // Sustained rate is (L - b + 1) per day, plus the initial burst.
    expect(sent.length).toBeGreaterThanOrEqual(3 * 991);
  });
});
