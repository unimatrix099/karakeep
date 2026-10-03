import { beforeEach, describe, expect, it, vi } from "vitest";

const getQueueClient = vi.fn();

vi.mock("./plugins", () => ({ loadAllPlugins: vi.fn() }));
vi.mock("@karakeep/shared/logger", () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@karakeep/shared/queueing", () => ({
  getQueueClient: () => getQueueClient(),
}));
vi.mock("@karakeep/shared/sqliteBusy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@karakeep/shared/sqliteBusy")>();
  return {
    ...actual,
    // Same behaviour, no real backoff delays.
    retryOnSqliteBusy: <T>(label: string, fn: () => Promise<T>) =>
      actual.retryOnSqliteBusy(label, fn, { initialDelayMs: 1 }),
  };
});

function busyError() {
  return Object.assign(new Error("database is locked"), {
    code: "SQLITE_BUSY",
  });
}

describe("prepareQueue", () => {
  beforeEach(() => {
    vi.resetModules();
    getQueueClient.mockReset();
  });

  it("retries when the queue client fails to open with SQLITE_BUSY", async () => {
    const client = { prepare: vi.fn().mockResolvedValue(undefined) };
    getQueueClient
      .mockRejectedValueOnce(busyError())
      .mockRejectedValueOnce(busyError())
      .mockResolvedValue(client);

    const { prepareQueue } = await import("./queues");
    await prepareQueue();

    expect(getQueueClient).toHaveBeenCalledTimes(3);
    expect(client.prepare).toHaveBeenCalledTimes(1);
  });

  it("retries when the queue migration fails with SQLITE_BUSY", async () => {
    const client = {
      prepare: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("Failed to run the query", { cause: busyError() }),
        )
        .mockResolvedValue(undefined),
    };
    getQueueClient.mockResolvedValue(client);

    const { prepareQueue } = await import("./queues");
    await prepareQueue();

    expect(client.prepare).toHaveBeenCalledTimes(2);
    // The client itself was created successfully, so it is reused.
    expect(getQueueClient).toHaveBeenCalledTimes(1);
  });

  it("does not retry other errors", async () => {
    getQueueClient.mockRejectedValue(new Error("bad config"));

    const { prepareQueue } = await import("./queues");
    await expect(prepareQueue()).rejects.toThrow("bad config");
    expect(getQueueClient).toHaveBeenCalledTimes(1);
  });
});
