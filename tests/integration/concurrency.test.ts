/**
 * Vitest Integration Test Suite for Concurrent Race Conditions & Leader-Follower Parking
 * Validates 50 parallel asynchronous workers targeting the identical idempotency key simultaneously,
 * verifying that the upstream payment API is executed exactly once, all 50 callers receive identical 200/201 payloads,
 * exactly one caller receives MISS, and 49 receive HIT over multiple consecutive test runs.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { ConnectionParkingLot } from '../../src/core/parking.js';
import { executeIdempotentMutation } from '../../src/core/orchestrator.js';

describe('Concurrent Race-Condition & Leader-Follower Test Suite', () => {
  let storage: MemoryStorageAdapter;
  let parkingLot: ConnectionParkingLot;

  beforeEach(() => {
    storage = new MemoryStorageAdapter({ capacity: 10_000 });
    parkingLot = new ConnectionParkingLot({
      defaultTimeoutMs: 15_000,
      maxParkedPerKey: 1_000,
      maxTotalParked: 50_000,
    });
  });

  afterEach(() => {
    parkingLot.clear();
    vi.restoreAllMocks();
  });

  it('coordinates 50 concurrent workers with random 10-50ms upstream delays: exactly 1 invocation, 1 MISS, 49 HIT', async () => {
    let upstreamInvocationCount = 0;
    const targetKey = 'concurrent-tx-100';
    const tenantId = 'stripe_prod';
    const totalWorkers = 50;

    // Mock upstream payment API with random 10-50ms latency
    const mockPaymentApi = vi.fn(async () => {
      upstreamInvocationCount++;
      const latencyMs = Math.floor(Math.random() * 40) + 10;
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return {
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: {
          chargeId: 'ch_99887766',
          status: 'SUCCEEDED',
          amount: 5000,
          currency: 'usd',
        },
      };
    });

    // Spawn 50 parallel asynchronous workers targeting the same idempotency key simultaneously
    const workerPromises = Array.from({ length: totalWorkers }, async (_, index) => {
      // Tiny random jitter (0-5ms) to simulate real-world microsecond arrival divergence
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      }

      return executeIdempotentMutation({
        tenantId,
        key: targetKey,
        storage,
        parkingLot,
        requestPayload: { amount: 5000, currency: 'usd' },
        action: mockPaymentApi,
      });
    });

    const results = await Promise.all(workerPromises);

    // 1. Assert upstream mock is invoked exactly once
    expect(upstreamInvocationCount).toBe(1);
    expect(mockPaymentApi).toHaveBeenCalledTimes(1);

    // 2. Assert all 50 callers receive identical response status and body
    expect(results).toHaveLength(totalWorkers);
    for (const res of results) {
      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({
        chargeId: 'ch_99887766',
        status: 'SUCCEEDED',
        amount: 5000,
        currency: 'usd',
      });
    }

    // 3. Exactly one caller receives role: 'LEADER' and idempotencyStatus: 'MISS'
    const missResults = results.filter((r) => r.idempotencyStatus === 'MISS');
    const hitResults = results.filter((r) => r.idempotencyStatus === 'HIT');

    expect(missResults).toHaveLength(1);
    expect(missResults[0].role).toBe('LEADER');

    // 4. Exactly 49 callers receive role: 'FOLLOWER' and idempotencyStatus: 'HIT'
    expect(hitResults).toHaveLength(totalWorkers - 1);
    for (const hit of hitResults) {
      expect(hit.role).toBe('FOLLOWER');
    }

    // 5. Zero connections remain parked after completion
    expect(parkingLot.getParkedCount(tenantId, targetKey)).toBe(0);
    expect(parkingLot.getTotalParkedCount()).toBe(0);
  });

  it('guarantees 100% pass rate across 5 consecutive rapid-fire stress cycles', async () => {
    const cycles = 5;

    for (let c = 0; c < cycles; c++) {
      let callCount = 0;
      const cycleKey = `stress-cycle-${c}`;

      const mockAction = vi.fn(async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          statusCode: 200,
          body: { cycle: c, processed: true },
        };
      });

      const promises = Array.from({ length: 25 }, () =>
        executeIdempotentMutation({
          tenantId: 'tenant_stress',
          key: cycleKey,
          storage,
          parkingLot,
          requestPayload: { cycle: c },
          action: mockAction,
        })
      );

      const batchResults = await Promise.all(promises);

      expect(callCount).toBe(1);
      expect(batchResults.filter((r) => r.idempotencyStatus === 'MISS')).toHaveLength(1);
      expect(batchResults.filter((r) => r.idempotencyStatus === 'HIT')).toHaveLength(24);
    }
  });

  it('propagates upstream errors to all concurrent parked followers if leader fails', async () => {
    let callCount = 0;
    const targetKey = 'failing-key-500';

    const failingMockAction = vi.fn(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('Downstream payment gateway timeout');
    });

    const promises = Array.from({ length: 10 }, () =>
      executeIdempotentMutation({
        tenantId: 'tenant_err',
        key: targetKey,
        storage,
        parkingLot,
        action: failingMockAction,
      }).catch((err) => ({ error: err.message }))
    );

    const results = await Promise.all(promises);

    expect(callCount).toBe(1);
    expect(results).toHaveLength(10);
    for (const r of results) {
      expect((r as any).error).toContain('Downstream payment gateway timeout');
    }

    // Storage record transitioned to FAILED/aborted
    const rec = await storage.get('tenant_err', targetKey);
    expect(rec?.status).toBe('FAILED');
    expect(parkingLot.getParkedCount('tenant_err', targetKey)).toBe(0);
  });
});
