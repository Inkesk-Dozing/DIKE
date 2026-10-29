/**
 * Dynamic Lease Renewal & Deadman Heartbeat Timers for DIKE
 * Automatically extends distributed lease TTL in Redis/storage for long-running mutations
 * up to a bounded maximum ceiling, releasing expired or crashed worker locks.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { Redis, Cluster } from 'ioredis';
import { formatClusterHashTag } from '../storage/redis_pool.js';
import { defaultLogger } from '../utils/logger.js';

export interface LeaseHeartbeatOptions {
  readonly tenantId: string;
  readonly key: string;
  readonly client: Redis | Cluster;
  /**
   * The duration in milliseconds for each lease renewal cycle.
   * Defaults to 15,000 ms (15s).
   */
  readonly leaseTtlMs?: number;
  /**
   * Interval at which the heartbeat runs. Defaults to leaseTtlMs / 3 (e.g. 5,000 ms).
   */
  readonly heartbeatIntervalMs?: number;
  /**
   * Absolute maximum cumulative lease extension ceiling in milliseconds.
   * Prevents deadlocks or indefinite lock retention for hung workers.
   * Defaults to 60,000 ms (60s).
   */
  readonly maxCeilingMs?: number;
  /**
   * Optional fencing token to guard renewal operations against zombie workers.
   */
  readonly fencingToken?: bigint | number | string;
  /**
   * Optional custom health check callback executed before each renewal.
   * If health check returns false or throws, heartbeat immediately halts.
   */
  readonly healthCheck?: () => boolean | Promise<boolean>;
  /**
   * Optional custom clock for deterministic testing.
   */
  readonly clock?: () => number;
}

export type HeartbeatStatus = 'IDLE' | 'RUNNING' | 'STOPPED' | 'CEILING_REACHED' | 'EXPIRED' | 'ERROR';

export class LeaseHeartbeatTimer {
  public readonly tenantId: string;
  public readonly key: string;
  public readonly redisKey: string;
  public readonly leaseTtlMs: number;
  public readonly heartbeatIntervalMs: number;
  public readonly maxCeilingMs: number;
  public readonly fencingToken: string | undefined;

  private readonly client: Redis | Cluster;
  private readonly healthCheck: (() => boolean | Promise<boolean>) | undefined;
  private readonly clock: () => number;

  private timerHandle: NodeJS.Timeout | null = null;
  private startTime: number = 0;
  private renewalsCount: number = 0;
  private status: HeartbeatStatus = 'IDLE';

  constructor(options: LeaseHeartbeatOptions) {
    if (!options.tenantId) {
      throw new Error('LeaseHeartbeatTimer requires a non-empty tenantId.');
    }
    if (!options.key) {
      throw new Error('LeaseHeartbeatTimer requires a non-empty key.');
    }
    if (!options.client) {
      throw new Error('LeaseHeartbeatTimer requires an active Redis or Cluster client.');
    }

    this.tenantId = options.tenantId;
    this.key = options.key;
    this.client = options.client;
    this.redisKey = formatClusterHashTag(this.tenantId, this.key);

    this.leaseTtlMs = options.leaseTtlMs ?? 15000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.floor(this.leaseTtlMs / 3);
    this.maxCeilingMs = options.maxCeilingMs ?? 60000;
    this.fencingToken = options.fencingToken !== undefined ? options.fencingToken.toString() : undefined;
    this.healthCheck = options.healthCheck;
    this.clock = options.clock ?? (() => Date.now());
  }

  public getStatus(): HeartbeatStatus {
    return this.status;
  }

  public getRenewalsCount(): number {
    return this.renewalsCount;
  }

  public getElapsedTimeMs(): number {
    if (this.startTime === 0) return 0;
    return this.clock() - this.startTime;
  }

  /**
   * Starts the periodic heartbeat renewal loop.
   */
  public start(): void {
    if (this.status === 'RUNNING') {
      return;
    }

    this.status = 'RUNNING';
    this.startTime = this.clock();
    this.renewalsCount = 0;

    this.scheduleNextHeartbeat();

    defaultLogger.debug({
      msg: 'Lease heartbeat timer started',
      tenantId: this.tenantId,
      key: this.key,
      leaseTtlMs: this.leaseTtlMs,
      intervalMs: this.heartbeatIntervalMs,
      maxCeilingMs: this.maxCeilingMs,
    });
  }

  /**
   * Gracefully stops the heartbeat timer (e.g. when mutation completes or aborts).
   */
  public stop(): void {
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.status === 'RUNNING') {
      this.status = 'STOPPED';
      defaultLogger.debug({
        msg: 'Lease heartbeat timer stopped gracefully',
        tenantId: this.tenantId,
        key: this.key,
        totalRenewals: this.renewalsCount,
      });
    }
  }

  /**
   * Executes a single atomic lease renewal step in Redis.
   * Returns true if renewal succeeded, false if key missing, fencing mismatched, or ceiling hit.
   */
  public async renewNow(): Promise<boolean> {
    const elapsed = this.clock() - this.startTime;

    if (elapsed + this.leaseTtlMs > this.maxCeilingMs) {
      this.status = 'CEILING_REACHED';
      this.stop();
      defaultLogger.warn({
        msg: 'Lease heartbeat ceiling reached. Terminating renewal to prevent deadlocks.',
        tenantId: this.tenantId,
        key: this.key,
        elapsedMs: elapsed,
        maxCeilingMs: this.maxCeilingMs,
      });
      return false;
    }

    // Health check verification
    if (this.healthCheck) {
      try {
        const isHealthy = await this.healthCheck();
        if (!isHealthy) {
          this.status = 'ERROR';
          this.stop();
          defaultLogger.warn({
            msg: 'Lease heartbeat aborted: worker health check reported unhealthy',
            tenantId: this.tenantId,
            key: this.key,
          });
          return false;
        }
      } catch (err) {
        this.status = 'ERROR';
        this.stop();
        defaultLogger.error({
          msg: 'Lease heartbeat aborted: worker health check threw exception',
          tenantId: this.tenantId,
          key: this.key,
          err,
        });
        return false;
      }
    }

    try {
      const renewalSucceeded = await this.executeRedisRenewal();
      if (renewalSucceeded) {
        this.renewalsCount++;
        return true;
      } else {
        this.status = 'EXPIRED';
        this.stop();
        return false;
      }
    } catch (err) {
      this.status = 'ERROR';
      this.stop();
      defaultLogger.error({
        msg: 'Redis lease renewal operation failed',
        tenantId: this.tenantId,
        key: this.key,
        err,
      });
      return false;
    }
  }

  private scheduleNextHeartbeat(): void {
    if (this.status !== 'RUNNING') return;

    this.timerHandle = setTimeout(async () => {
      if (this.status !== 'RUNNING') return;

      const ok = await this.renewNow();
      if (ok && this.status === 'RUNNING') {
        this.scheduleNextHeartbeat();
      }
    }, this.heartbeatIntervalMs);

    // Unref timer if running in Node.js environment so it does not keep event loop awake
    if (this.timerHandle && typeof this.timerHandle.unref === 'function') {
      this.timerHandle.unref();
    }
  }

  /**
   * Executes atomic renewal via Lua or PEXPIRE.
   * If fencingToken is provided, checks that current record status is 'STARTED'
   * and fencingToken matches before updating lockedUntilMs and calling PEXPIRE.
   */
  private async executeRedisRenewal(): Promise<boolean> {
    const rawRecord = await this.client.get(this.redisKey);
    if (!rawRecord) {
      return false;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawRecord);
    } catch {
      // If not JSON, fall back to direct PEXPIRE
      const pexpireResult = await this.client.pexpire(this.redisKey, this.leaseTtlMs);
      return pexpireResult === 1;
    }

    // Only active STARTED records can be renewed
    if (parsed.status !== 'STARTED') {
      return false;
    }

    // Fencing token verification
    if (this.fencingToken !== undefined && parsed.fencingToken !== undefined) {
      if (parsed.fencingToken !== this.fencingToken) {
        defaultLogger.warn({
          msg: 'Fencing token mismatch during lease heartbeat renewal',
          tenantId: this.tenantId,
          key: this.key,
          expected: this.fencingToken,
          actual: parsed.fencingToken,
        });
        return false;
      }
    }

    const now = this.clock();
    const updatedLockedUntilMs = now + this.leaseTtlMs;
    const updatedLockedUntil = new Date(updatedLockedUntilMs).toISOString();

    parsed.lockedUntilMs = updatedLockedUntilMs;
    parsed.lockedUntil = updatedLockedUntil;
    parsed.updatedAt = new Date(now).toISOString();

    const ttlSeconds = Math.ceil(this.leaseTtlMs / 1000);
    await this.client.set(this.redisKey, JSON.stringify(parsed), 'EX', ttlSeconds);

    // Also extend the cluster fencing key if exists
    const fencingKey = `${this.redisKey}:fence`;
    await this.client.pexpire(fencingKey, this.leaseTtlMs).catch(() => {});

    return true;
  }
}

/**
 * Convenience helper to wrap any asynchronous long-running task with an automatic heartbeat.
 */
export async function withLeaseHeartbeat<T>(
  options: LeaseHeartbeatOptions,
  action: (timer: LeaseHeartbeatTimer) => Promise<T>,
): Promise<T> {
  const timer = new LeaseHeartbeatTimer(options);
  timer.start();
  try {
    return await action(timer);
  } finally {
    timer.stop();
  }
}
