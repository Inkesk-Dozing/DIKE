/**
 * Vitest Unit Test Suite for Bounded Client Parking Timeout Handlers
 * Validates bounded timeout enforcement, 504 Gateway Timeout payloads, event listener cleanup,
 * and zero memory leak warnings under sustained follower parking.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionParkingLot } from '../../src/core/parking.js';
import {
  BoundedParkingHandler,
  waitWithBoundedTimeout,
  GatewayTimeoutError,
} from '../../src/core/parking_timeout.js';

describe('Bounded Client Parking Timeout Handlers', () => {
  let parkingLot: ConnectionParkingLot;
  let mockTime: number;

  beforeEach(() => {
    mockTime = 1_000_000;
    parkingLot = new ConnectionParkingLot({
      defaultTimeoutMs: 15_000,
      maxParkedPerKey: 500,
      maxTotalParked: 5_000,
    });
  });

  afterEach(() => {
    parkingLot.clear();
    vi.restoreAllMocks();
  });

  it('initializes BoundedParkingHandler with default and explicit parameters', () => {
    const handler = new BoundedParkingHandler({
      parkingLot,
      tenantId: 'tenant_test',
      key: 'order_123',
      timeoutMs: 15_000,
      traceId: 'trace-abc-123',
    });

    expect(handler.tenantId).toBe('tenant_test');
    expect(handler.key).toBe('order_123');
    expect(handler.timeoutMs).toBe(15_000);
    expect(handler.traceId).toBe('trace-abc-123');
  });

  it('rejects construction with missing or invalid parameters', () => {
    expect(() => new BoundedParkingHandler({ parkingLot: null as any, tenantId: 't', key: 'k' })).toThrow();
    expect(() => new BoundedParkingHandler({ parkingLot, tenantId: '', key: 'k' })).toThrow();
    expect(() => new BoundedParkingHandler({ parkingLot, tenantId: 't', key: '' })).toThrow();
  });

  it('unparks successfully with RESOLVED status and response when leader resolves within timeout window', async () => {
    const handler = new BoundedParkingHandler({
      parkingLot,
      tenantId: 'tenant_1',
      key: 'key_fast',
      timeoutMs: 5_000,
      clock: () => mockTime,
    });

    const waitPromise = handler.executeWait();

    // Advance clock slightly and broadcast resolution from leader
    mockTime += 250;
    parkingLot.broadcast('tenant_1', 'key_fast', {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: { status: 'PAID', amount: 100 },
    });

    const result = await waitPromise;

    expect(result.status).toBe('RESOLVED');
    if (result.status === 'RESOLVED') {
      expect(result.statusCode).toBe(200);
      expect(result.headers).toEqual({ 'content-type': 'application/json' });
      expect(result.body).toEqual({ status: 'PAID', amount: 100 });
      expect(result.elapsedMs).toBe(250);
    }

    // Verify parking counts cleaned up
    expect(parkingLot.getParkedCount('tenant_1', 'key_fast')).toBe(0);
    expect(parkingLot.getTotalParkedCount()).toBe(0);
  });

  it('returns ABORTED status when leader aborts execution', async () => {
    const handler = new BoundedParkingHandler({
      parkingLot,
      tenantId: 'tenant_1',
      key: 'key_abort',
      timeoutMs: 5_000,
      clock: () => mockTime,
    });

    const waitPromise = handler.executeWait();
    mockTime += 300;
    parkingLot.abort('tenant_1', 'key_abort', 'Database deadlock encountered');

    const result = await waitPromise;

    expect(result.status).toBe('ABORTED');
    if (result.status === 'ABORTED') {
      expect(result.statusCode).toBe(500);
      expect(result.error).toBe('UpstreamAborted');
      expect(result.message).toContain('Database deadlock encountered');
      expect(result.elapsedMs).toBe(300);
    }

    expect(parkingLot.getParkedCount('tenant_1', 'key_abort')).toBe(0);
  });

  it('emits HTTP 504 Gateway Timeout when leader does not resolve before timeout elapses', async () => {
    vi.useFakeTimers();

    const handler = new BoundedParkingHandler({
      parkingLot,
      tenantId: 'tenant_1',
      key: 'key_timeout',
      timeoutMs: 15_000,
      clock: () => mockTime,
    });

    const waitPromise = handler.executeWait();

    // Advance virtual timers past 15,000ms
    mockTime += 15_000;
    vi.advanceTimersByTime(15_000);

    const result = await waitPromise;

    expect(result.status).toBe('TIMEOUT');
    if (result.status === 'TIMEOUT') {
      expect(result.response.statusCode).toBe(504);
      expect(result.response.error).toBe('GatewayTimeout');
      expect(result.response.key).toBe('key_timeout');
      expect(result.response.tenantId).toBe('tenant_1');
      expect(result.response.message).toContain('timed out');
      expect(result.elapsedMs).toBe(15_000);
    }

    // Verify listeners and metrics are completely cleaned up
    expect(parkingLot.getParkedCount('tenant_1', 'key_timeout')).toBe(0);
    expect(parkingLot.getTotalParkedCount()).toBe(0);

    vi.useRealTimers();
  });

  it('waitWithBoundedTimeout throws GatewayTimeoutError when throwOnTimeout is true', async () => {
    vi.useFakeTimers();

    const waitPromise = waitWithBoundedTimeout(
      {
        parkingLot,
        tenantId: 'tenant_strict',
        key: 'key_strict',
        timeoutMs: 10_000,
        clock: () => mockTime,
      },
      true
    );

    mockTime += 10_000;
    vi.advanceTimersByTime(10_000);

    await expect(waitPromise).rejects.toThrow(GatewayTimeoutError);
    await expect(waitPromise).rejects.toThrow(/timed out after 10000ms/);

    vi.useRealTimers();
  });

  it('guarantees zero memory leaks and cleans up all listeners across 100 concurrent parked followers', async () => {
    vi.useFakeTimers();

    const followersCount = 100;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < followersCount; i++) {
      const handler = new BoundedParkingHandler({
        parkingLot,
        tenantId: 'tenant_scale',
        key: 'concurrent_key',
        timeoutMs: 15_000,
        traceId: `trace-${i}`,
        clock: () => mockTime,
      });
      promises.push(handler.executeWait());
    }

    expect(parkingLot.getParkedCount('tenant_scale', 'concurrent_key')).toBe(100);
    expect(parkingLot.getTotalParkedCount()).toBe(100);

    // Allow timeout to expire for all followers
    mockTime += 15_000;
    vi.advanceTimersByTime(15_000);

    const results = await Promise.all(promises);

    expect(results).toHaveLength(100);
    for (const res of results) {
      expect(res.status).toBe('TIMEOUT');
      expect(res.response.statusCode).toBe(504);
    }

    // Absolute deallocation verification: 0 remaining listeners or counts
    expect(parkingLot.getParkedCount('tenant_scale', 'concurrent_key')).toBe(0);
    expect(parkingLot.getTotalParkedCount()).toBe(0);

    vi.useRealTimers();
  });
});

