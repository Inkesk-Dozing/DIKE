/**
 * In-Memory L1 Fast-Path Storage Adapter for DIKE
 * Ultra-low-latency LRU cache implementing atomic state transitions with sub-microsecond lookups.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { IIdempotencyStorage } from './interface.js';
import {
  IdempotencyRecord,
  AcquireOptions,
  AcquireResult,
  ResolveOptions,
  AbortOptions,
  FencingTokenViolationError,
} from '../core/types.js';
import { IdempotencyFSM } from '../core/fsm.js';

export interface MemoryStorageOptions {
  readonly capacity?: number | undefined;
  readonly defaultLockTimeoutMs?: number | undefined;
}

export class MemoryStorageAdapter implements IIdempotencyStorage {
  private readonly store = new Map<string, IdempotencyRecord>();
  private readonly capacity: number;
  private readonly defaultLockTimeoutMs: number;
  private fencingCounter = 1n;

  constructor(options: MemoryStorageOptions = {}) {
    this.capacity = options.capacity ?? 50_000;
    this.defaultLockTimeoutMs = options.defaultLockTimeoutMs ?? 30_000;
  }

  private compositeKey(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  public async acquire(options: AcquireOptions): Promise<AcquireResult> {
    const cKey = this.compositeKey(options.tenantId, options.key);
    const existing = this.store.get(cKey);
    const now = Date.now();

    if (existing) {
      // Check expiration
      if (existing.expiresAt.getTime() <= now) {
        this.store.delete(cKey);
      } else if (existing.status === 'RESOLVED') {
        if (existing.requestFingerprint !== options.requestFingerprint) {
          return { status: 'PAYLOAD_MISMATCH', record: existing };
        }
        // LRU bump
        this.store.delete(cKey);
        this.store.set(cKey, existing);
        return { status: 'CACHED', record: existing };
      } else if (existing.status === 'STARTED') {
        const isLocked = existing.lockedUntil && existing.lockedUntil.getTime() > now;
        if (isLocked) {
          if (existing.requestFingerprint !== options.requestFingerprint) {
            return { status: 'PAYLOAD_MISMATCH', record: existing };
          }
          return {
            status: 'IN_PROGRESS',
            record: existing,
            fencingToken: existing.fencingToken,
          };
        }
        // Lock expired: fall through to re-acquire / take over
      }
    }

    // Allocate / take over lease
    const nextFencingToken = ++this.fencingCounter;
    const currentOrNull = this.store.get(cKey) ?? null;

    const transition = IdempotencyFSM.transitionToStarted(
      currentOrNull,
      options.tenantId,
      options.key,
      options.requestFingerprint,
      options.ttlMs,
      nextFencingToken
    );

    // Enforce capacity bounds (LRU eviction)
    if (this.store.size >= this.capacity) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) {
        this.store.delete(oldestKey);
      }
    }

    this.store.set(cKey, transition.record);

    return {
      status: 'ACQUIRED',
      record: transition.record,
      fencingToken: nextFencingToken,
    };
  }

  public async resolve(options: ResolveOptions): Promise<void> {
    const cKey = this.compositeKey(options.tenantId, options.key);
    const record = this.store.get(cKey);

    if (!record) {
      throw new Error(`Idempotency record for key "${options.key}" does not exist in memory storage.`);
    }

    // Verify fencing token monotonicity
    if (options.fencingToken !== undefined && record.fencingToken !== undefined) {
      if (options.fencingToken < record.fencingToken) {
        throw new FencingTokenViolationError(options.key, record.fencingToken, options.fencingToken);
      }
    }

    const transition = IdempotencyFSM.transitionToResolved(
      record,
      options.responseStatus,
      options.responseHeaders,
      options.responseBody
    );

    // LRU bump
    this.store.delete(cKey);
    this.store.set(cKey, transition.record);
  }

  public async abort(options: AbortOptions): Promise<void> {
    const cKey = this.compositeKey(options.tenantId, options.key);
    const record = this.store.get(cKey);

    if (!record) {
      throw new Error(`Idempotency record for key "${options.key}" does not exist in memory storage.`);
    }

    if (options.fencingToken !== undefined && record.fencingToken !== undefined) {
      if (options.fencingToken < record.fencingToken) {
        throw new FencingTokenViolationError(options.key, record.fencingToken, options.fencingToken);
      }
    }

    const transition = IdempotencyFSM.transitionToFailed(record, options.errorReason);
    this.store.delete(cKey);
    this.store.set(cKey, transition.record);
  }

  public async get(tenantId: string, key: string): Promise<IdempotencyRecord | null> {
    const cKey = this.compositeKey(tenantId, key);
    const record = this.store.get(cKey);

    if (!record) {
      return null;
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      this.store.delete(cKey);
      return null;
    }

    // LRU bump
    this.store.delete(cKey);
    this.store.set(cKey, record);
    return record;
  }

  public async evict(tenantId: string, key: string): Promise<boolean> {
    const cKey = this.compositeKey(tenantId, key);
    return this.store.delete(cKey);
  }

  /**
   * Sweeps expired records across the storage map.
   * Returns total count of evicted records.
   */
  public sweepExpired(): number {
    const now = Date.now();
    let evicted = 0;

    for (const [key, record] of this.store.entries()) {
      if (record.expiresAt.getTime() <= now) {
        this.store.delete(key);
        evicted++;
      }
    }

    return evicted;
  }

  public async close(): Promise<void> {
    this.store.clear();
  }

  public size(): number {
    return this.store.size;
  }
}
