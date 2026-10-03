export class AsyncSemaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    } else {
      return new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
    } else {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }
}

export function limitConcurrency<T>(
  promises: (() => Promise<T>)[],
  concurrencyLimit: number,
): Promise<T>[] {
  const semaphore = new AsyncSemaphore(concurrencyLimit);
  const results: Promise<T>[] = [];

  for (const promiseFunction of promises) {
    results.push(
      semaphore
        .acquire()
        .then(() => {
          return promiseFunction();
        })
        .finally(() => {
          semaphore.release();
        }),
    );
  }
  return results;
}

/**
 * Runs `fn` over `items` in sequential chunks of `chunkSize` (items inside a
 * chunk run concurrently), sleeping `pauseMs` between chunks.
 *
 * Used for bulk SQLite writes (e.g. enqueueing thousands of jobs): better-sqlite3
 * is synchronous, so an unbroken burst of writes starves other processes that
 * wait on the same database lock until their busy timeout expires. The pause
 * leaves the lock free long enough for them to get in.
 */
export async function runInChunks<T>(
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
  {
    chunkSize = 50,
    pauseMs = 25,
  }: { chunkSize?: number; pauseMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < items.length; i += chunkSize) {
    if (i > 0 && pauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    await Promise.all(items.slice(i, i + chunkSize).map(fn));
  }
}
