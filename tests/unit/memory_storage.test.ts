import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { FencingTokenViolationError } from '../../src/core/types.js';

describe('MemoryStorageAdapter (L1 Fast-Path Cache)', () => {
  let storage: MemoryStorageAdapter;
  const tenantId = 'tenant-test';
  const key = 'tx-order-550';
  const fingerprint = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

  beforeEach(() => {
    storage = new MemoryStorageAdapter({ capacity: 1000 });
  });

  it('atomically acquires a new lease', async () => {
    const result = await storage.acquire({
      tenantId,
      key,
      requestFingerprint: fingerprint,
      ttlMs: 60_000,
    });

    expect(result.status).toBe('ACQUIRED');
    expect(result.record).toBeDefined();
    expect(result.record?.status).toBe('STARTED');
    expect(result.fencingToken).toBeGreaterThan(0n);
  });

  it('resolves response and returns CACHED on subsequent acquire', async () => {
    const acquireRes = await storage.acquire({
      tenantId,
      key,
      requestFingerprint: fingerprint,
      ttlMs: 60_000,
    });

    await storage.resolve({
      tenantId,
      key,
      responseStatus: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: { success: true },
      fencingToken: acquireRes.fencingToken,
    });

    const secondAcquire = await storage.acquire({
      tenantId,
      key,
      requestFingerprint: fingerprint,
      ttlMs: 60_000,
    });

    expect(secondAcquire.status).toBe('CACHED');
    expect(secondAcquire.record?.responseStatus).toBe(200);
    expect(secondAcquire.record?.responseBody).toEqual({ success: true });
  });

  it('detects and flags PAYLOAD_MISMATCH on duplicate key with different hash', async () => {
    const acquireRes = await storage.acquire({
      tenantId,
      key,
      requestFingerprint: fingerprint,
      ttlMs: 60_000,
    });

    await storage.resolve({
      tenantId,
      key,
      responseStatus: 200,
      fencingToken: acquireRes.fencingToken,
    });

    const mismatchRes = await storage.acquire({
      tenantId,
      key,
      requestFingerprint: 'different-payload-fingerprint-hex-string',
      ttlMs: 60_000,
    });

    expect(mismatchRes.status).toBe('PAYLOAD_MISMATCH');
  });

  it('returns IN_PROGRESS for concurrent request while lease is active', async () => {
    await storage.acquire({
      tenantId,
      key,
      requestFingerprint: fingerprint,
      ttlMs: 60_000,
    });

    const inProgressRes = await storage.acquire({
      tenantId,
      key,
      requestFingerprint: fingerprint,
      ttlMs: 60_000,
    });

    expect(inProgressRes.status).toBe('IN_PROGRESS');
  });

  it('blocks zombie writers with stale fencing token', async () => {
    const acquireRes = await storage.acquire({
      tenantId,
      key,
      requestFingerprint: fingerprint,
      ttlMs: 60_000,
    });

    const staleToken = acquireRes.fencingToken! - 1n;

    await expect(
      storage.resolve({
        tenantId,
        key,
        responseStatus: 200,
        fencingToken: staleToken,
      })
    ).rejects.toThrow(FencingTokenViolationError);
  });

  it('evicts oldest key when capacity is exceeded (LRU bound)', async () => {
    const smallStorage = new MemoryStorageAdapter({ capacity: 3 });

    await smallStorage.acquire({ tenantId, key: 'k1', requestFingerprint: 'f1', ttlMs: 60_000 });
    await smallStorage.acquire({ tenantId, key: 'k2', requestFingerprint: 'f2', ttlMs: 60_000 });
    await smallStorage.acquire({ tenantId, key: 'k3', requestFingerprint: 'f3', ttlMs: 60_000 });

    // Access k1 to make it most recently used
    await smallStorage.get(tenantId, 'k1');

    // Adding k4 should evict k2 (oldest)
    await smallStorage.acquire({ tenantId, key: 'k4', requestFingerprint: 'f4', ttlMs: 60_000 });

    expect(await smallStorage.get(tenantId, 'k2')).toBeNull();
    expect(await smallStorage.get(tenantId, 'k1')).not.toBeNull();
    expect(await smallStorage.get(tenantId, 'k3')).not.toBeNull();
    expect(await smallStorage.get(tenantId, 'k4')).not.toBeNull();
  });

  it('purges expired keys via sweepExpired', async () => {
    // Record with 1ms TTL
    await storage.acquire({
      tenantId,
      key: 'expiring-key',
      requestFingerprint: fingerprint,
      ttlMs: 1,
    });

    // Wait 5ms for TTL to elapse
    await new Promise((r) => setTimeout(r, 5));

    const sweptCount = storage.sweepExpired();
    expect(sweptCount).toBe(1);
    expect(await storage.get(tenantId, 'expiring-key')).toBeNull();
  });

  it('satisfies high-throughput benchmark (> 10,000 ops in < 250ms)', async () => {
    const benchStorage = new MemoryStorageAdapter({ capacity: 100_000 });
    const iterations = 10_000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      await benchStorage.acquire({
        tenantId,
        key: `bench-${i}`,
        requestFingerprint: fingerprint,
        ttlMs: 60_000,
      });
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250);
  });
});
