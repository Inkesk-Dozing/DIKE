/**
 * Unit Test Suite for Atomic Redis Lua Lease Acquisition
 * Tests atomic check-and-set semantics, race immunity across 100 concurrent callers, EVALSHA fallbacks, and payload mismatches.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisStorageAdapter } from '../../src/storage/redis.js';
import { executeAcquireLeaseLua, ACQUIRE_LEASE_SHA } from '../../src/storage/lua/lua_runner.js';
import { Redis } from 'ioredis';

// Enhanced mock for ioredis that simulates Redis server Lua evaluation
vi.mock('ioredis', () => {
  class MockRedis {
    public store = new Map<string, string>();
    public fencingStore = new Map<string, number>();

    public ping = vi.fn().mockResolvedValue('PONG');
    public quit = vi.fn().mockResolvedValue('OK');
    public disconnect = vi.fn().mockReturnValue(undefined);

    public get = vi.fn().mockImplementation(async (key: string) => {
      return this.store.get(key) ?? null;
    });

    public set = vi.fn().mockImplementation(async (key: string, value: string) => {
      this.store.set(key, value);
      return 'OK';
    });

    public del = vi.fn().mockImplementation(async (...keys: string[]) => {
      let count = 0;
      for (const k of keys) {
        if (this.store.delete(k)) count++;
      }
      return count;
    });

    public ttl = vi.fn().mockResolvedValue(3600);
    public expire = vi.fn().mockResolvedValue(1);

    public incr = vi.fn().mockImplementation(async (key: string) => {
      const current = this.fencingStore.get(key) ?? 0;
      const next = current + 1;
      this.fencingStore.set(key, next);
      return next;
    });

    /**
     * Simulates Redis Lua script execution atomically
     */
    public eval = vi.fn().mockImplementation(
      async (
        _script: string,
        _numkeys: number,
        recordKey: string,
        fencingKey: string,
        fingerprint: string,
        ttlMsStr: string,
        lockTimeoutMsStr: string,
        currentTimeIso: string,
        recordId: string,
        nowMsStr: string
      ) => {
        const existingRaw = this.store.get(recordKey);
        const nowMs = Number(nowMsStr);
        const ttlMs = Number(ttlMsStr);
        const lockTimeoutMs = Number(lockTimeoutMsStr);

        if (existingRaw) {
          const record = JSON.parse(existingRaw);
          if (record.status === 'RESOLVED') {
            if (record.requestFingerprint !== fingerprint) {
              return JSON.stringify({ status: 'PAYLOAD_MISMATCH', record });
            }
            return JSON.stringify({ status: 'CACHED', record });
          } else if (record.status === 'STARTED') {
            let isLocked = true;
            if (record.lockedUntilMs && record.lockedUntilMs <= nowMs) {
              isLocked = false;
            }
            if (isLocked) {
              if (record.requestFingerprint !== fingerprint) {
                return JSON.stringify({ status: 'PAYLOAD_MISMATCH', record });
              }
              return JSON.stringify({
                status: 'IN_PROGRESS',
                record,
                fencingToken: record.fencingToken,
              });
            }
          }
        }

        const fence = (this.fencingStore.get(fencingKey) ?? 0) + 1;
        this.fencingStore.set(fencingKey, fence);

        const newRecord = {
          id: recordId,
          requestFingerprint: fingerprint,
          status: 'STARTED',
          fencingToken: String(fence),
          lockedUntilMs: nowMs + Math.min(ttlMs, lockTimeoutMs),
          lockedUntil: currentTimeIso,
          expiresAtMs: nowMs + ttlMs,
          createdAt: currentTimeIso,
          updatedAt: currentTimeIso,
        };

        this.store.set(recordKey, JSON.stringify(newRecord));

        return JSON.stringify({
          status: 'ACQUIRED',
          record: newRecord,
          fencingToken: String(fence),
        });
      }
    );

    public evalsha = vi.fn().mockImplementation(async (sha: string, ...args: unknown[]) => {
      if (sha === ACQUIRE_LEASE_SHA) {
        // Delegate to mock eval simulation
        return (this.eval as Function)('SCRIPT', ...args);
      }
      throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    });
  }

  class MockCluster extends MockRedis {}

  return {
    Redis: MockRedis,
    Cluster: MockCluster,
    default: MockRedis,
  };
});

describe('Atomic Lease Acquisition via Custom Redis Lua Script', () => {
  let adapter: RedisStorageAdapter;

  beforeEach(() => {
    adapter = new RedisStorageAdapter();
  });

  it('atomically grants lease on fresh idempotency key via Lua evalsha', async () => {
    const result = await adapter.acquire({
      tenantId: 'tenant-lua',
      key: 'tx-lua-101',
      requestFingerprint: 'sha256-fingerprint-aaa',
      ttlMs: 60_000,
    });

    expect(result.status).toBe('ACQUIRED');
    expect(result.fencingToken).toBe(1n);
    expect(result.record?.status).toBe('STARTED');
    expect(result.record?.key).toBe('tx-lua-101');
    expect(result.record?.tenantId).toBe('tenant-lua');
  });

  it('returns IN_PROGRESS for simultaneous duplicate requests under active lease', async () => {
    const acquireOptions = {
      tenantId: 'tenant-lua',
      key: 'tx-lua-102',
      requestFingerprint: 'sha256-fingerprint-bbb',
      ttlMs: 60_000,
    };

    const first = await adapter.acquire(acquireOptions);
    expect(first.status).toBe('ACQUIRED');

    const second = await adapter.acquire(acquireOptions);
    expect(second.status).toBe('IN_PROGRESS');
    expect(second.fencingToken).toBe(1n);
  });

  it('detects and flags PAYLOAD_MISMATCH if in-flight request carries altered body', async () => {
    await adapter.acquire({
      tenantId: 'tenant-lua',
      key: 'tx-lua-103',
      requestFingerprint: 'sha256-hash-original',
      ttlMs: 60_000,
    });

    const tampered = await adapter.acquire({
      tenantId: 'tenant-lua',
      key: 'tx-lua-103',
      requestFingerprint: 'sha256-hash-tampered',
      ttlMs: 60_000,
    });

    expect(tampered.status).toBe('PAYLOAD_MISMATCH');
  });

  it('guarantees single-winner race condition immunity across 100 concurrent executions', async () => {
    const concurrentOptions = {
      tenantId: 'tenant-burst',
      key: 'tx-burst-999',
      requestFingerprint: 'sha256-burst-fingerprint',
      ttlMs: 60_000,
    };

    // Dispatch 100 simultaneous concurrent lease acquisition calls
    const promises = Array.from({ length: 100 }, () => adapter.acquire(concurrentOptions));
    const results = await Promise.all(promises);

    const acquired = results.filter((r) => r.status === 'ACQUIRED');
    const inProgress = results.filter((r) => r.status === 'IN_PROGRESS');

    // Exactly one winner gets the lease; remaining 99 are parked / in-progress
    expect(acquired).toHaveLength(1);
    expect(inProgress).toHaveLength(99);
    expect(acquired[0]?.fencingToken).toBe(1n);
  });

  it('falls back to EVAL cleanly when Redis raises NOSCRIPT error', async () => {
    const mockClient = new Redis();
    // Simulate cache eviction on Redis server: first evalsha throws NOSCRIPT
    (mockClient.evalsha as any).mockRejectedValueOnce(
      new Error('NOSCRIPT No matching script. Please use EVAL.')
    );

    const result = await executeAcquireLeaseLua(mockClient, {
      tenantId: 'tenant-fallback',
      key: 'tx-fallback-1',
      requestFingerprint: 'sha256-fallback',
      ttlMs: 60_000,
    });

    expect(result.status).toBe('ACQUIRED');
    expect(mockClient.eval).toHaveBeenCalledTimes(1);
  });
});
