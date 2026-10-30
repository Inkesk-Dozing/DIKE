/**
 * Vitest Unit Test Suite for Storage Tier Fallback Circuit Breaker
 * Validates automatic failover from Redis to PostgreSQL on consecutive timeouts,
 * cool-off timers, half-open canary probes, and seamless recovery.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StorageCircuitBreaker } from '../../src/storage/fallback.js';
import { IIdempotencyStorage } from '../../src/storage/interface.js';
import { AcquireResult } from '../../src/core/types.js';

describe('Storage Tier Fallback Circuit Breaker', () => {
  let mockPrimary: IIdempotencyStorage;
  let mockFallback: IIdempotencyStorage;
  let mockTime: number;

  beforeEach(() => {
    mockTime = 1_000_000;

    mockPrimary = {
      acquire: vi.fn(),
      resolve: vi.fn(),
      abort: vi.fn(),
      get: vi.fn(),
      evict: vi.fn(),
      close: vi.fn(),
    };

    mockFallback = {
      acquire: vi.fn(),
      resolve: vi.fn(),
      abort: vi.fn(),
      get: vi.fn(),
      evict: vi.fn(),
      close: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes in CLOSED state with healthy primary routing', () => {
    const cb = new StorageCircuitBreaker({
      primaryStorage: mockPrimary,
      fallbackStorage: mockFallback,
      failureThreshold: 5,
      cooloffDurationMs: 30_000,
      clock: () => mockTime,
    });

    expect(cb.getState()).toBe('CLOSED');
    expect(cb.failureThreshold).toBe(5);
    expect(cb.cooloffDurationMs).toBe(30_000);
  });

  it('rejects initialization without primary or fallback storage', () => {
    expect(
      () =>
        new StorageCircuitBreaker({
          primaryStorage: null as any,
          fallbackStorage: mockFallback,
        })
    ).toThrow();

    expect(
      () =>
        new StorageCircuitBreaker({
          primaryStorage: mockPrimary,
          fallbackStorage: null as any,
        })
    ).toThrow();
  });

  it('routes acquire to primary and returns result when healthy', async () => {
    const successResult: AcquireResult = {
      status: 'ACQUIRED',
      fencingToken: 1n,
    };
    (mockPrimary.acquire as any).mockResolvedValue(successResult);

    const cb = new StorageCircuitBreaker({
      primaryStorage: mockPrimary,
      fallbackStorage: mockFallback,
      clock: () => mockTime,
    });

    const result = await cb.acquire({
      tenantId: 'tenant_1',
      key: 'key_1',
      requestFingerprint: 'hash123',
    });

    expect(result).toBe(successResult);
    expect(mockPrimary.acquire).toHaveBeenCalledTimes(1);
    expect(mockFallback.acquire).not.toHaveBeenCalled();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('trips circuit to OPEN after 5 consecutive failures and degrades to fallback', async () => {
    (mockPrimary.acquire as any).mockRejectedValue(new Error('Redis connection timeout ETIMEDOUT'));
    const fallbackResult: AcquireResult = {
      status: 'ACQUIRED',
      fencingToken: 42n,
    };
    (mockFallback.acquire as any).mockResolvedValue(fallbackResult);

    const cb = new StorageCircuitBreaker({
      primaryStorage: mockPrimary,
      fallbackStorage: mockFallback,
      failureThreshold: 5,
      cooloffDurationMs: 30_000,
      clock: () => mockTime,
    });

    // Execute 5 failed calls through primary
    for (let i = 0; i < 5; i++) {
      const res = await cb.acquire({
        tenantId: 'tenant_1',
        key: `key_${i}`,
        requestFingerprint: 'hash',
      });
      expect(res).toBe(fallbackResult);
    }

    expect(mockPrimary.acquire).toHaveBeenCalledTimes(5);
    expect(mockFallback.acquire).toHaveBeenCalledTimes(5);
    expect(cb.getState()).toBe('OPEN');

    // 6th call while circuit is OPEN must bypass primary entirely
    const call6 = await cb.acquire({
      tenantId: 'tenant_1',
      key: 'key_6',
      requestFingerprint: 'hash',
    });

    expect(call6).toBe(fallbackResult);
    expect(mockPrimary.acquire).toHaveBeenCalledTimes(5); // Primary was NOT touched!
    expect(mockFallback.acquire).toHaveBeenCalledTimes(6);
  });

  it('transitions from OPEN to HALF_OPEN after cooloff elapses and recovers upon canary success', async () => {
    (mockPrimary.acquire as any).mockRejectedValue(new Error('Redis timeout'));
    const fallbackResult: AcquireResult = { status: 'ACQUIRED', fencingToken: 10n };
    (mockFallback.acquire as any).mockResolvedValue(fallbackResult);

    const cb = new StorageCircuitBreaker({
      primaryStorage: mockPrimary,
      fallbackStorage: mockFallback,
      failureThreshold: 2,
      cooloffDurationMs: 30_000,
      clock: () => mockTime,
    });

    // Trip circuit: 2 failures
    await cb.acquire({ tenantId: 't', key: 'k1', requestFingerprint: 'h' });
    await cb.acquire({ tenantId: 't', key: 'k2', requestFingerprint: 'h' });
    expect(cb.getState()).toBe('OPEN');

    // Fast-forward mock clock past 30s cooloff
    mockTime += 30_000;
    expect(cb.getState()).toBe('HALF_OPEN');

    // Primary now recovers!
    const primaryRecoveredResult: AcquireResult = { status: 'ACQUIRED', fencingToken: 99n };
    (mockPrimary.acquire as any).mockResolvedValue(primaryRecoveredResult);

    // Canary probe execution
    const probeResult = await cb.acquire({ tenantId: 't', key: 'k_canary', requestFingerprint: 'h' });
    expect(probeResult).toBe(primaryRecoveredResult);

    // Circuit restored to CLOSED
    expect(cb.getState()).toBe('CLOSED');
  });

  it('trips back to OPEN if canary probe in HALF_OPEN fails', async () => {
    (mockPrimary.acquire as any).mockRejectedValue(new Error('Redis timeout'));
    (mockFallback.acquire as any).mockResolvedValue({ status: 'ACQUIRED', fencingToken: 1n });

    const cb = new StorageCircuitBreaker({
      primaryStorage: mockPrimary,
      fallbackStorage: mockFallback,
      failureThreshold: 2,
      cooloffDurationMs: 30_000,
      clock: () => mockTime,
    });

    // Trip circuit to OPEN
    await cb.acquire({ tenantId: 't', key: 'k1', requestFingerprint: 'h' });
    await cb.acquire({ tenantId: 't', key: 'k2', requestFingerprint: 'h' });
    expect(cb.getState()).toBe('OPEN');

    // Advance to HALF_OPEN
    mockTime += 30_000;
    expect(cb.getState()).toBe('HALF_OPEN');

    // Canary probe fails again
    (mockPrimary.acquire as any).mockRejectedValue(new Error('Redis still down'));
    await cb.acquire({ tenantId: 't', key: 'k_canary', requestFingerprint: 'h' });

    // Must immediately trip back to OPEN
    expect(cb.getState()).toBe('OPEN');
  });

  it('routes resolve, abort, get, and evict methods through circuit breaker', async () => {
    const cb = new StorageCircuitBreaker({
      primaryStorage: mockPrimary,
      fallbackStorage: mockFallback,
      clock: () => mockTime,
    });

    (mockPrimary.resolve as any).mockResolvedValue(undefined);
    await cb.resolve({ tenantId: 't', key: 'k', responseStatus: 200 });
    expect(mockPrimary.resolve).toHaveBeenCalledTimes(1);

    (mockPrimary.abort as any).mockResolvedValue(undefined);
    await cb.abort({ tenantId: 't', key: 'k', reason: 'err' });
    expect(mockPrimary.abort).toHaveBeenCalledTimes(1);

    (mockPrimary.get as any).mockResolvedValue(null);
    await cb.get('t', 'k');
    expect(mockPrimary.get).toHaveBeenCalledTimes(1);

    (mockPrimary.evict as any).mockResolvedValue(true);
    await cb.evict('t', 'k');
    expect(mockPrimary.evict).toHaveBeenCalledTimes(1);
  });
});
