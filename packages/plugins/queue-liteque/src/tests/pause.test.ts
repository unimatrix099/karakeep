import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  DequeuedJob,
  QueueClient,
  RunnerOptions,
} from "@karakeep/shared/queueing";

interface Payload {
  name: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(20);
  }
}

let client: QueueClient;
let dataDir: string;
let queueCounter = 0;
// Loaded after vi.resetModules() so it's the same class the plugin checks.
let QueueRetryAfterError: typeof import("@karakeep/shared/queueing").QueueRetryAfterError;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "liteque-pause-"));
  vi.stubEnv("DATA_DIR", dataDir);
  vi.resetModules();
  const { LitequeQueueProvider } = await import("../index");
  ({ QueueRetryAfterError } = await import("@karakeep/shared/queueing"));
  const c = await new LitequeQueueProvider().getClient();
  if (!c) throw new Error("no queue client");
  client = c;
  await client.prepare();
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Runs a fresh queue with the given behaviour and records when each job ran.
async function startQueue(
  run: (job: DequeuedJob<Payload>, attempt: number) => Promise<void>,
  opts: Partial<RunnerOptions<Payload>>,
) {
  const queue = client.createQueue<Payload>(`pause-test-${queueCounter++}`, {
    defaultJobArgs: { numRetries: 3 },
    keepFailedJobs: false,
  });
  const calls: { name: string; at: number }[] = [];
  const attempts = new Map<string, number>();
  const runner = client.createRunner<Payload>(
    queue,
    {
      run: async (job) => {
        calls.push({ name: job.data.name, at: Date.now() });
        const attempt = (attempts.get(job.data.name) ?? 0) + 1;
        attempts.set(job.data.name, attempt);
        await run(job, attempt);
      },
    },
    { concurrency: 1, timeoutSecs: 30, pollIntervalMs: 50, ...opts },
  );
  return { queue, runner, calls };
}

const pauseError = (delayMs: number) =>
  new QueueRetryAfterError("rate limited", delayMs, { pauseQueue: true });

describe("liteque runner pause on rate limit", () => {
  it("stops dequeuing until the pause ends", async () => {
    const { queue, runner, calls } = await startQueue(
      async (job, attempt) => {
        if (job.data.name === "a" && attempt === 1) throw pauseError(1_000);
      },
      { pauseOnRateLimit: true },
    );
    await queue.enqueue({ name: "a" });
    await queue.enqueue({ name: "b" });
    await queue.enqueue({ name: "c" });

    const running = runner.run();
    await waitFor(() => calls.length >= 4);
    runner.stop();
    await running;

    // The held-back job keeps its place in line once the pause ends.
    expect(calls.map((c) => c.name)).toEqual(["a", "a", "b", "c"]);
    // Nothing ran during the pause...
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(950);
    // ...and afterwards the queue runs normally again.
    expect(calls[2].at - calls[1].at).toBeLessThan(500);
  });

  it("keeps dequeuing immediately when pauseOnRateLimit is off", async () => {
    const { queue, runner, calls } = await startQueue(
      async (job, attempt) => {
        if (job.data.name === "a" && attempt === 1) throw pauseError(1_000);
      },
      {},
    );
    await queue.enqueue({ name: "a" });
    await queue.enqueue({ name: "b" });

    const running = runner.run();
    await waitFor(() => calls.length >= 2);
    runner.stop();
    await running;

    expect(calls.map((c) => c.name)).toEqual(["a", "b"]);
    expect(calls[1].at - calls[0].at).toBeLessThan(500);
  });

  it("does not pause for retry errors that don't ask for it", async () => {
    const { queue, runner, calls } = await startQueue(
      async (job, attempt) => {
        if (job.data.name === "a" && attempt === 1) {
          throw new QueueRetryAfterError("domain limited", 1_000);
        }
      },
      { pauseOnRateLimit: true },
    );
    await queue.enqueue({ name: "a" });
    await queue.enqueue({ name: "b" });

    const running = runner.run();
    await waitFor(() => calls.length >= 2);
    runner.stop();
    await running;

    expect(calls[1].name).toBe("b");
    expect(calls[1].at - calls[0].at).toBeLessThan(500);
  });

  it("runs the highest-priority job first when the pause ends", async () => {
    const { queue, runner, calls } = await startQueue(
      async (job, attempt) => {
        if (job.data.name === "low-1" && attempt === 1) throw pauseError(800);
      },
      { pauseOnRateLimit: true },
    );
    await queue.enqueue({ name: "low-1" }, { priority: 10 });
    await queue.enqueue({ name: "low-2" }, { priority: 10 });

    const running = runner.run();
    await waitFor(() => calls.length >= 1);
    // A new bookmark arrives while the queue is paused.
    await queue.enqueue({ name: "new" }, { priority: 0 });
    await waitFor(() => calls.length >= 4);
    runner.stop();
    await running;

    // Priority first, then creation order (the held-back job keeps its place).
    expect(calls.map((c) => c.name)).toEqual([
      "low-1",
      "new",
      "low-1",
      "low-2",
    ]);
  });
});
