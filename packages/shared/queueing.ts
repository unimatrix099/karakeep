import { ZodType } from "zod";

import { PluginManager, PluginType } from "./plugins";

/**
 * Special error that indicates a job should be retried after a delay
 * without counting against the retry attempts limit.
 * Useful for handling rate limiting scenarios.
 */
export class QueueRetryAfterError extends Error {
  /**
   * When true, runners created with `pauseOnRateLimit` also stop dequeuing
   * jobs for `delayMs`, instead of immediately dequeuing the next job (which
   * would most likely hit the same limit).
   */
  public readonly pauseQueue: boolean;

  constructor(
    message: string,
    public readonly delayMs: number,
    opts?: { pauseQueue?: boolean },
  ) {
    super(message);
    this.name = "QueueRetryAfterError";
    this.pauseQueue = opts?.pauseQueue ?? false;
  }
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  priority?: number;
  delayMs?: number;
  groupId?: string;
}

export interface QueueOptions {
  defaultJobArgs: {
    numRetries: number;
  };
  keepFailedJobs: boolean;
}

export function queueOptionsEqual(
  left: QueueOptions,
  right: QueueOptions,
): boolean {
  return (
    left.defaultJobArgs.numRetries === right.defaultJobArgs.numRetries &&
    left.keepFailedJobs === right.keepFailedJobs
  );
}

export interface DequeuedJob<T> {
  id: string;
  data: T;
  priority: number;
  runNumber: number;
  abortSignal: AbortSignal;
}

export interface DequeuedJobError<T> {
  id: string;
  data?: T;
  priority: number;
  error: Error;
  runNumber: number;
  numRetriesLeft: number;
}

export interface RunnerFuncs<T, R = void> {
  run: (job: DequeuedJob<T>) => Promise<R>;
  onComplete?: (job: DequeuedJob<T>, result: R) => Promise<void>;
  onError?: (job: DequeuedJobError<T>) => Promise<void>;
}

export interface RunnerOptions<T> {
  pollIntervalMs?: number;
  timeoutSecs: number;
  concurrency: number;
  validator?: ZodType<T>;
  /**
   * Stop dequeuing while a job's QueueRetryAfterError asks to pause the queue.
   * Only for queues whose jobs all share the limit that triggered it.
   */
  pauseOnRateLimit?: boolean;
}

export interface Queue<T> {
  opts: QueueOptions;
  ensureInit(): Promise<void>;
  name(): string;
  enqueue(payload: T, options?: EnqueueOptions): Promise<string | undefined>;
  stats(): Promise<{
    pending: number;
    pending_retry: number;
    running: number;
    failed: number;
  }>;
  cancelAllNonRunning?(): Promise<number>;
}

export interface Runner<_T> {
  run(): Promise<void>;
  stop(): void;
  runUntilEmpty?(): Promise<void>;
}

export interface QueueClient {
  prepare(): Promise<void>;
  start(): Promise<void>;
  createQueue<T>(name: string, options: QueueOptions): Queue<T>;
  createRunner<T, R = void>(
    queue: Queue<T>,
    funcs: RunnerFuncs<T, R>,
    opts: RunnerOptions<T>,
  ): Runner<T>;
  shutdown?(): Promise<void>;
}

export async function getQueueClient(): Promise<QueueClient> {
  const client = await PluginManager.getClient(PluginType.Queue);
  if (!client) {
    throw new Error("Failed to get queue client");
  }
  return client;
}
