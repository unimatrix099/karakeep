import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Each worker passes its runner options to createRunner(); capture them.
const createRunner = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("@karakeep/shared/queueing", async (original) => ({
  ...(await original<typeof import("@karakeep/shared/queueing")>()),
  getQueueClient: vi.fn(async () => ({ createRunner })),
}));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workers-pause-"));

beforeAll(() => {
  vi.stubEnv("DATA_DIR", dataDir);
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function lastRunnerOptions() {
  const calls = createRunner.mock.calls as unknown[][];
  return calls[calls.length - 1][2] as { pauseOnRateLimit?: boolean };
}

describe("rate limit pause per worker", () => {
  it("pauses the inference queue when the LLM limit is hit", async () => {
    const { OpenAiWorker } = await import("./inference/inferenceWorker");
    await OpenAiWorker.build();
    expect(lastRunnerOptions().pauseOnRateLimit).toBe(true);
  });

  it("pauses the embeddings queue when the embedding limit is hit", async () => {
    const { EmbeddingsWorker } = await import("./embeddingsWorker");
    await EmbeddingsWorker.build();
    expect(lastRunnerOptions().pauseOnRateLimit).toBe(true);
  });

  it("does not pause asset preprocessing (most of its jobs don't use the LLM)", async () => {
    const { AssetPreprocessingWorker } = await import(
      "./assetPreprocessingWorker"
    );
    await AssetPreprocessingWorker.build();
    expect(lastRunnerOptions().pauseOnRateLimit).toBeFalsy();
  });
});
