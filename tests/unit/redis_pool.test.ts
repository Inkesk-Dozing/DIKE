/**
 * Unit Test Suite for Redis Connection Manager & Redis Storage Adapter
 * Tests standalone, Sentinel, and Cluster topologies, hash tag routing, and exponential jittered backoff.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RedisConnectionManager,
  calculateJitteredBackoff,
  formatClusterHashTag,
} from '../../src/storage/redis_pool.js';
import { RedisStorageAdapter } from '../../src/storage/redis.js';

// Mock ioredis completely for isolated unit suite
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
  }

  class MockCluster extends MockRedis {}

  return {
    Redis: MockRedis,
    Cluster: MockCluster,
    default: MockRedis,
  };
});

describe('Redis Connection Manager & Pool Topology', () => {
  describe('calculateJitteredBackoff', () => {
    it('calculates exponential delay bounded by maxDelayMs with random jitter', () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const delay = calculateJitteredBackoff(attempt, 50, 1000);
        expect(delay).toBeGreaterThanOrEqual(25); // 50 * 0.5 minimum jitter
        expect(delay).toBeLessThanOrEqual(1500); // 1000 * 1.5 maximum jitter
      }
    });
  });

  describe('formatClusterHashTag', () => {
    it('wraps tenant and key in braces to enforce single-slot hash routing', () => {
      expect(formatClusterHashTag('tenantA', 'key123')).toBe('{tenantA:key123}');
      expect(formatClusterHashTag('tenantA', 'key123', 'fence')).toBe('{tenantA:key123}:fence');
      expect(formatClusterHashTag('tenantA', 'key123', 'lock')).toBe('{tenantA:key123}:lock');
    });
  });

  describe('RedisConnectionManager lifecycle', () => {
    it('initializes standalone client and performs successful healthCheck', async () => {
      const manager = new RedisConnectionManager({ mode: 'standalone' });
      const client = await manager.getClient();
      expect(client).toBeDefined();

      const healthy = await manager.healthCheck();
      expect(healthy).toBe(true);

      await manager.close();
    });

    it('initializes Sentinel client when sentinels list is supplied', async () => {
      const manager = new RedisConnectionManager({
        sentinelMasterName: 'mymaster',
        sentinels: [{ host: '127.0.0.1', port: 26379 }],
      });
      const client = await manager.getClient();
      expect(client).toBeDefined();
      await manager.close();
    });

    it('initializes Cluster client when clusterNodes list is supplied', async () => {
      const manager = new RedisConnectionManager({
        clusterNodes: [{ host: '127.0.0.1', port: 7000 }],
      });
      const client = await manager.getClient();
      expect(client).toBeDefined();
      await manager.close();
    });
  });

  describe('RedisStorageAdapter Integration', () => {
    let adapter: RedisStorageAdapter;

    beforeEach(() => {
      adapter = new RedisStorageAdapter();
    });

    it('acquires fresh idempotency lease with cluster hash tagged keys', async () => {
      const result = await adapter.acquire({
        tenantId: 'tenant-100',
        key: 'tx-ord-1',
        requestFingerprint: 'sha256-hash-1',
        ttlMs: 60_000,
      });

      expect(result.status).toBe('ACQUIRED');
      expect(result.fencingToken).toBe(1n);
      expect(result.record?.status).toBe('STARTED');
    });

    it('resolves active lease and commits cached response payload', async () => {
      await adapter.acquire({
        tenantId: 'tenant-100',
        key: 'tx-ord-2',
        requestFingerprint: 'sha256-hash-2',
        ttlMs: 60_000,
      });

      await adapter.resolve({
        tenantId: 'tenant-100',
        key: 'tx-ord-2',
        responseStatus: 200,
        responseHeaders: { 'x-processed-by': 'dike-l2' },
        responseBody: { success: true },
        fencingToken: 1n,
      });

      const retrieved = await adapter.get('tenant-100', 'tx-ord-2');
      expect(retrieved?.status).toBe('RESOLVED');
      expect(retrieved?.responseStatus).toBe(200);
      expect(retrieved?.responseHeaders?.['x-processed-by']).toBe('dike-l2');
    });

    it('returns CACHED on subsequent acquire with identical payload', async () => {
      const acquireOptions = {
        tenantId: 'tenant-100',
        key: 'tx-ord-3',
        requestFingerprint: 'sha256-hash-3',
        ttlMs: 60_000,
      };

      await adapter.acquire(acquireOptions);
      await adapter.resolve({
        tenantId: 'tenant-100',
        key: 'tx-ord-3',
        responseStatus: 201,
        fencingToken: 1n,
      });

      const secondAcquire = await adapter.acquire(acquireOptions);
      expect(secondAcquire.status).toBe('CACHED');
      expect(secondAcquire.record?.responseStatus).toBe(201);
    });

    it('detects PAYLOAD_MISMATCH on duplicate key with divergent fingerprint', async () => {
      await adapter.acquire({
        tenantId: 'tenant-100',
        key: 'tx-ord-4',
        requestFingerprint: 'sha256-hash-initial',
        ttlMs: 60_000,
      });

      await adapter.resolve({
        tenantId: 'tenant-100',
        key: 'tx-ord-4',
        responseStatus: 200,
        fencingToken: 1n,
      });

      const mismatchAcquire = await adapter.acquire({
        tenantId: 'tenant-100',
        key: 'tx-ord-4',
        requestFingerprint: 'sha256-hash-tampered',
        ttlMs: 60_000,
      });

      expect(mismatchAcquire.status).toBe('PAYLOAD_MISMATCH');
    });

    it('aborts active lease and transitions status to FAILED', async () => {
      await adapter.acquire({
        tenantId: 'tenant-100',
        key: 'tx-ord-5',
        requestFingerprint: 'sha256-hash-5',
        ttlMs: 60_000,
      });

      await adapter.abort({
        tenantId: 'tenant-100',
        key: 'tx-ord-5',
        errorReason: 'Payment gateway timeout',
        fencingToken: 1n,
      });

      const retrieved = await adapter.get('tenant-100', 'tx-ord-5');
      expect(retrieved?.status).toBe('FAILED');
    });

    it('evicts records from Redis cleanly', async () => {
      await adapter.acquire({
        tenantId: 'tenant-100',
        key: 'tx-ord-6',
        requestFingerprint: 'sha256-hash-6',
        ttlMs: 60_000,
      });

      const evicted = await adapter.evict('tenant-100', 'tx-ord-6');
      expect(evicted).toBe(true);

      const notFound = await adapter.get('tenant-100', 'tx-ord-6');
      expect(notFound).toBeNull();
    });
  });
});
