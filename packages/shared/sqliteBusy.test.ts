import { afterEach, describe, expect, it, vi } from "vitest";

import { isSqliteBusyError, retryOnSqliteBusy } from "./sqliteBusy";

function sqliteError(code: string) {
  return Object.assign(new Error("database is locked"), { code });
}

describe("isSqliteBusyError", () => {
  it("matches busy and locked codes, including extended ones", () => {
    expect(isSqliteBusyError(sqliteError("SQLITE_BUSY"))).toBe(true);
    expect(isSqliteBusyError(sqliteError("SQLITE_BUSY_SNAPSHOT"))).toBe(true);
    expect(isSqliteBusyError(sqliteError("SQLITE_LOCKED"))).toBe(true);
  });

  it("follows the cause chain (e.g. a DrizzleError wrapping SqliteError)", () => {
    const wrapped = new Error("Failed to run the query", {
      cause: sqliteError("SQLITE_BUSY"),
    });
    expect(isSqliteBusyError(wrapped)).toBe(true);
  });

  it("rejects other errors", () => {
    expect(isSqliteBusyError(sqliteError("SQLITE_CONSTRAINT"))).toBe(false);
    expect(isSqliteBusyError(new Error("boom"))).toBe(false);
    expect(isSqliteBusyError(undefined)).toBe(false);
    expect(isSqliteBusyError("SQLITE_BUSY")).toBe(false);
  });
});

describe("retryOnSqliteBusy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries busy errors with backoff until it succeeds", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(sqliteError("SQLITE_BUSY"))
      .mockRejectedValueOnce(sqliteError("SQLITE_BUSY"))
      .mockResolvedValue("ok");

    const result = retryOnSqliteBusy("test", fn, {
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
    // Second wait doubles.
    await vi.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("caps the delay at maxDelayMs", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(sqliteError("SQLITE_BUSY"))
      .mockRejectedValueOnce(sqliteError("SQLITE_BUSY"))
      .mockResolvedValue();

    const result = retryOnSqliteBusy("test", fn, {
      initialDelayMs: 100,
      maxDelayMs: 150,
    });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(150);
    await result;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows non-busy errors immediately", async () => {
    const fn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("boom"));
    await expect(retryOnSqliteBusy("test", fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt and rethrows the busy error", async () => {
    const err = sqliteError("SQLITE_BUSY");
    const fn = vi.fn<() => Promise<void>>().mockRejectedValue(err);
    await expect(
      retryOnSqliteBusy("test", fn, { attempts: 3, initialDelayMs: 1 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
