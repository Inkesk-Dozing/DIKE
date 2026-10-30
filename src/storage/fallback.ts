/**
 * Storage Tier Fallback Circuit Breaker for DIKE
 * Wraps primary distributed storage (Redis L2) with circuit-breaking failover
 * to durable PostgreSQL (L3) row-level locks (SELECT ... FOR UPDATE) upon consecutive failures,
 * with cooldown half-open recovery probes and zero payment pipeline crashes.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { IIdempotencyStorage } from './interface.js';
import {
  IdempotencyRecord,
  AcquireOptions,
  AcquireResult,
  ResolveOptions,
  AbortOptions,
} from '../core/types.js';
import { defaultLogger } from '../utils/logger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface StorageCircuitBreakerOptions {
  /**
   * Primary high-throughput storage adapter (typically Redis L2).
   */
  readonly primaryStorage: IIdempotencyStorage;
  /**
   * Fallback durable storage adapter (typically PostgreSQL L3).
   */
  readonly fallbackStorage: IIdempotencyStorage;
  /**
   * Number of consecutive primary errors before tripping circuit to OPEN.
   * Defaults to 5.
   */
  readonly failureThreshold?: number;
  /**
   * Duration in milliseconds the circuit remains OPEN before transitioning to HALF_OPEN.
   * Defaults to 30,000 ms (30 seconds).
   */
  readonly cooloffDurationMs?: number;
  /**
   * Optional custom clock for deterministic testing.
   */
  readonly clock?: () => number;
}

export interface CircuitTelemetry {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly successCount: number;
  readonly lastFailureTime: number | null;
  readonly lastStateChangeTime: number;
  readonly cooloffDurationMs: number;
}

export class StorageCircuitBreaker implements IIdempotencyStorage {
  public readonly primaryStorage: IIdempotencyStorage;
  public readonly fallbackStorage: IIdempotencyStorage;
  public readonly failureThreshold: number;
  public readonly cooloffDurationMs: number;

  private state: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number | null = null;
  private lastStateChangeTime: number;
  private readonly clock: () => number;

  constructor(options: StorageCircuitBreakerOptions) {
    if (!options.primaryStorage) {
      throw new Error('StorageCircuitBreaker requires a primaryStorage adapter.');
    }
    if (!options.fallbackStorage) {
      throw new Error('StorageCircuitBreaker requires a fallbackStorage adapter.');
    }

    this.primaryStorage = options.primaryStorage;
    this.fallbackStorage = options.fallbackStorage;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooloffDurationMs = options.cooloffDurationMs ?? 30_000;
    this.clock = options.clock ?? (() => Date.now());
    this.lastStateChangeTime = this.clock();
  }

  public getState(): CircuitState {
    this.checkCooloffTransition();
    return this.state;
  }

  public getTelemetry(): CircuitTelemetry {
    this.checkCooloffTransition();
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastStateChangeTime: this.lastStateChangeTime,
      cooloffDurationMs: this.cooloffDurationMs,
    };
  }

  /**
   * Checks if cooldown period has elapsed in OPEN state, transitioning to HALF_OPEN canary mode.
   */
  private checkCooloffTransition(): void {
    if (this.state === 'OPEN') {
      const elapsed = this.clock() - this.lastStateChangeTime;
      if (elapsed >= this.cooloffDurationMs) {
        this.transitionTo('HALF_OPEN');
        defaultLogger.warn({
          msg: 'Storage circuit breaker cool-off elapsed; transitioning to HALF_OPEN canary probe',
          elapsedMs: elapsed,
          cooloffLimitMs: this.cooloffDurationMs,
        });
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    const previousState = this.state;
    this.state = newState;
    this.lastStateChangeTime = this.clock();

    if (newState === 'CLOSED') {
      this.failureCount = 0;
      this.successCount = 0;
      defaultLogger.info({
        msg: 'Storage circuit breaker recovered; transitioned to CLOSED (Primary Active)',
        previousState,
      });
    } else if (newState === 'OPEN') {
      defaultLogger.error({
        msg: 'Storage circuit breaker TRIPPED to OPEN; all operations degraded to PostgreSQL fallback',
        consecutiveFailures: this.failureCount,
        cooloffDurationMs: this.cooloffDurationMs,
      });
    }
  }

  private recordPrimarySuccess(): void {
    if (this.state === 'HALF_OPEN') {
      // Canary probe succeeded, restore to CLOSED
      this.transitionTo('CLOSED');
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  private recordPrimaryFailure(error: unknown, operation: string): void {
    this.lastFailureTime = this.clock();
    this.failureCount++;

    defaultLogger.error({
      msg: `Primary storage operation failed in circuit breaker (${operation})`,
      operation,
      consecutiveFailures: this.failureCount,
      currentState: this.state,
      err: error,
    });

    if (this.state === 'HALF_OPEN') {
      // Canary probe failed; immediately trip back to OPEN for another cooldown cycle
      this.transitionTo('OPEN');
    } else if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
      this.transitionTo('OPEN');
    }
  }

  /**
   * Executes a storage operation through circuit breaker with automatic fallback to secondary.
   */
  private async executeWithFallback<T>(
    operationName: string,
    executePrimary: (storage: IIdempotencyStorage) => Promise<T>,
    executeFallback: (storage: IIdempotencyStorage) => Promise<T>
  ): Promise<T> {
    this.checkCooloffTransition();

    // In OPEN state, bypass primary completely and route directly to fallback
    if (this.state === 'OPEN') {
      defaultLogger.debug({
        msg: `Circuit OPEN; routing ${operationName} directly to PostgreSQL fallback`,
      });
      return executeFallback(this.fallbackStorage);
    }

    // In CLOSED or HALF_OPEN state, attempt primary
    try {
      const result = await executePrimary(this.primaryStorage);
      this.recordPrimarySuccess();
      return result;
    } catch (primaryErr) {
      this.recordPrimaryFailure(primaryErr, operationName);

      // Gracefully degrade to fallback storage
      defaultLogger.warn({
        msg: `Primary failed during ${operationName}; executing on PostgreSQL fallback tier`,
        err: primaryErr,
      });

      return executeFallback(this.fallbackStorage);
    }
  }

  public async acquire(options: AcquireOptions): Promise<AcquireResult> {
    return this.executeWithFallback(
      'acquire',
      (s) => s.acquire(options),
      (s) => s.acquire(options)
    );
  }

  public async resolve(options: ResolveOptions): Promise<void> {
    return this.executeWithFallback(
      'resolve',
      (s) => s.resolve(options),
      (s) => s.resolve(options)
    );
  }

  public async abort(options: AbortOptions): Promise<void> {
    return this.executeWithFallback(
      'abort',
      (s) => s.abort(options),
      (s) => s.abort(options)
    );
  }

  public async get(tenantId: string, key: string): Promise<IdempotencyRecord | null> {
    return this.executeWithFallback(
      'get',
      (s) => s.get(tenantId, key),
      (s) => s.get(tenantId, key)
    );
  }

  public async evict(tenantId: string, key: string): Promise<boolean> {
    return this.executeWithFallback(
      'evict',
      (s) => s.evict(tenantId, key),
      (s) => s.evict(tenantId, key)
    );
  }

  public async close(): Promise<void> {
    await Promise.allSettled([
      this.primaryStorage.close(),
      this.fallbackStorage.close(),
    ]);
  }
}
