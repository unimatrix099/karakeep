import Database from "better-sqlite3";

interface OpenSqliteOptions {
  readOnly: boolean;
  walMode: boolean;
  busyTimeoutMs?: number;
}

export function openSqliteDatabase(
  filename: string,
  options: OpenSqliteOptions,
) {
  const sqlite = new Database(filename, {
    ...(options.readOnly ? { readonly: true, fileMustExist: true } : {}),
    // How long a statement waits for a lock held by another connection before
    // failing with SQLITE_BUSY. better-sqlite3 waits synchronously, blocking
    // the event loop, so keep this modest.
    // Omit the key when unset: better-sqlite3 rejects `timeout: undefined`
    // instead of falling back to its 5s default.
    ...(options.busyTimeoutMs !== undefined
      ? { timeout: options.busyTimeoutMs }
      : {}),
  });

  if (!options.readOnly) {
    if (options.walMode) {
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = NORMAL");
    } else {
      sqlite.pragma("journal_mode = DELETE");
    }
  }
  sqlite.pragma("cache_size = -65536");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("temp_store = MEMORY");

  if (options.readOnly) {
    sqlite.pragma("query_only = ON");
  }

  return sqlite;
}
