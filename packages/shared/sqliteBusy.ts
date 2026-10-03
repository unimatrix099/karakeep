import logger from "./logger";

/**
 * True if `err`, or any error in its `cause` chain, is SQLite reporting that
 * the database is locked by another connection (SQLITE_BUSY / SQLITE_LOCKED,
 * including extended codes such as SQLITE_BUSY_SNAPSHOT).
 */
export function isSqliteBusyError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 10; depth++) {
    const code = (current as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs `fn`, retrying with exponential backoff while it fails because the
 * database is locked. Any other error, or a busy error on the last attempt,
 * is rethrown.
 */
export async function retryOnSqliteBusy<T>(
  label: string,
  fn: () => Promise<T>,
  {
    attempts = 6,
    initialDelayMs = 2000,
    maxDelayMs = 10000,
  }: { attempts?: number; initialDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  let delayMs = initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isSqliteBusyError(err)) {
        throw err;
      }
      logger.warn(
        `[${label}] Database is locked (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}
