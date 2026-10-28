/**
 * In-Memory TTL Sliding Expiration Sweeper Worker
 * Background worker that proactively purges expired L1 cache records in bounded batch slices (< 2ms).
 * Prevents memory leak buildup and event loop starvation under sustained high load.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { MemoryStorageAdapter } from './memory.js';

export interface MemorySweeperOptions {
  /**
   * Interval between sweep cycles in milliseconds.
   * Defaults to 10,000 ms (10 seconds).
   */
  readonly intervalMs?: number | undefined;

  /**
   * Maximum records to inspect per batch slice to protect the Node.js event loop.
   * Defaults to 500 records.
   */
  readonly batchSize?: number | undefined;

  /**
   * Hard time ceiling in milliseconds permitted per sweep run.
   * Defaults to 2.0 ms.
   */
  readonly maxCycleDurationMs?: number | undefined;

  /**
   * Optional logger or telemetry callback invoked after each sweep cycle.
   */
  readonly onSweep?: ((stats: SweepCycleStats) => void) | undefined;
}

export interface SweepCycleStats {
  readonly inspected: number;
  readonly evicted: number;
  readonly durationMs: number;
  readonly remainingSize: number;
  readonly timestamp: Date;
}

export class MemorySweeperWorker {
  private readonly storage: MemoryStorageAdapter;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxCycleDurationMs: number;
  private readonly onSweep?: ((stats: SweepCycleStats) => void) | undefined;

  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private totalEvictedCount = 0;
  private totalCyclesCount = 0;

  constructor(storage: MemoryStorageAdapter, options: MemorySweeperOptions = {}) {
    this.storage = storage;
    this.intervalMs = options.intervalMs ?? 10_000;
    this.batchSize = options.batchSize ?? 500;
    this.maxCycleDurationMs = options.maxCycleDurationMs ?? 2.0;
    this.onSweep = options.onSweep;
  }

  /**
   * Starts the background sweeper worker loop.
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.timer = setInterval(() => {
      this.runSweepCycle();
    }, this.intervalMs);

    // Unref timer so the background sweeper does not keep Node.js process alive if idle
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Stops the background sweeper worker loop.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  /**
   * Executes a single, bounded sweep cycle.
   * Returns telemetry for the completed cycle.
   */
  public runSweepCycle(): SweepCycleStats {
    const startTime = performance.now();
    const now = Date.now();
    let inspected = 0;
    let evicted = 0;

    // Use memory adapter internal store entry inspection
    const rawStore = (this.storage as unknown as { store: Map<string, { expiresAt: Date }> }).store;

    if (rawStore && rawStore.size > 0) {
      for (const [key, record] of rawStore.entries()) {
        inspected++;

        if (record.expiresAt.getTime() <= now) {
          rawStore.delete(key);
          evicted++;
        }

        // Bounded loop checks: stop if batch ceiling is reached or execution exceeds duration limit
        if (inspected >= this.batchSize) {
          break;
        }

        if (inspected % 50 === 0 && performance.now() - startTime >= this.maxCycleDurationMs) {
          break;
        }
      }
    }

    const durationMs = performance.now() - startTime;
    this.totalEvictedCount += evicted;
    this.totalCyclesCount++;

    const stats: SweepCycleStats = {
      inspected,
      evicted,
      durationMs,
      remainingSize: this.storage.size(),
      timestamp: new Date(),
    };

    if (this.onSweep) {
      try {
        this.onSweep(stats);
      } catch {
        // Suppress telemetry callback errors to avoid crashing sweeper loop
      }
    }

    return stats;
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public getTotalEvicted(): number {
    return this.totalEvictedCount;
  }

  public getTotalCycles(): number {
    return this.totalCyclesCount;
  }
}
