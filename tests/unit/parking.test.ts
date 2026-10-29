/**
 * Unit Test Suite for Asynchronous Connection Parking Engine
 * Tests EventBus multiplexing, 50+ concurrent parked sockets, timeout fallbacks, capacity ceilings, and abort signals.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionParkingLot } from '../../src/core/parking.js';

describe('Asynchronous Connection Parking Engine (EventBus Multiplexer)', () => {
  let lot: ConnectionParkingLot;

  beforeEach(() => {
    lot = new ConnectionParkingLot({
      defaultTimeoutMs: 1000,
      maxParkedPerKey: 100,
      maxTotalParked: 500,
    });
  });

  it('parks 50 concurrent follower requests and unparks them simultaneously on leader broadcast', async () => {
    const tenantId = 'tenant-park';
    const key = 'tx-order-888';

    // Simulate 50 concurrent duplicate requests hitting the parking engine
    const followers = Array.from({ length: 50 }, () => lot.waitFor(tenantId, key));

    expect(lot.getParkedCount(tenantId, key)).toBe(50);
    expect(lot.getTotalParkedCount()).toBe(50);

    // Leader completes mutation and broadcasts response
    const payload = {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: { orderId: 'ord-888', total: 199.99 },
    };

    const unparkedCount = lot.broadcast(tenantId, key, payload);
    expect(unparkedCount).toBe(50);

    const results = await Promise.all(followers);

    // Assert all 50 parked requests resolved with identical payload
    for (const res of results) {
      expect(res.status).toBe('RESOLVED');
      expect(res.response?.statusCode).toBe(201);
      expect(res.response?.body).toEqual({ orderId: 'ord-888', total: 199.99 });
    }

    // Assert lot internal memory cleanup
    expect(lot.getParkedCount(tenantId, key)).toBe(0);
    expect(lot.getTotalParkedCount()).toBe(0);
  });

  it('unparks followers with ABORTED status when leader aborts execution', async () => {
    const tenantId = 'tenant-abort';
    const key = 'tx-order-abort-1';

    const followers = Array.from({ length: 5 }, () => lot.waitFor(tenantId, key));
    expect(lot.getParkedCount(tenantId, key)).toBe(5);

    lot.abort(tenantId, key, 'Upstream payment processor unreachable');

    const results = await Promise.all(followers);
    for (const res of results) {
      expect(res.status).toBe('ABORTED');
      expect(res.errorReason).toBe('Upstream payment processor unreachable');
    }

    expect(lot.getParkedCount(tenantId, key)).toBe(0);
  });

  it('gracefully times out parked connections when leader execution stalls', async () => {
    const tenantId = 'tenant-timeout';
    const key = 'tx-order-hang';

    // Park with a tight 50ms timeout
    const result = await lot.waitFor(tenantId, key, 50);

    expect(result.status).toBe('TIMEOUT');
    expect(result.errorReason).toContain('exceeded timeout of 50ms');
    expect(lot.getParkedCount(tenantId, key)).toBe(0);
    expect(lot.getTotalParkedCount()).toBe(0);
  });

  it('enforces maximum per-key capacity ceiling', async () => {
    const tightLot = new ConnectionParkingLot({
      maxParkedPerKey: 2,
    });

    const tenantId = 'tenant-cap';
    const key = 'tx-overloaded';

    // Park 2 callers
    tightLot.waitFor(tenantId, key);
    tightLot.waitFor(tenantId, key);

    // 3rd caller exceeds per-key ceiling
    const overflowResult = await tightLot.waitFor(tenantId, key);
    expect(overflowResult.status).toBe('TIMEOUT');
    expect(overflowResult.errorReason).toContain('capacity of 2 exceeded');
  });

  it('clears all listeners and resets counts on clear()', () => {
    lot.waitFor('t', 'k1');
    lot.waitFor('t', 'k2');
    expect(lot.getTotalParkedCount()).toBe(2);

    lot.clear();
    expect(lot.getTotalParkedCount()).toBe(0);
    expect(lot.getParkedCount('t', 'k1')).toBe(0);
  });
});
