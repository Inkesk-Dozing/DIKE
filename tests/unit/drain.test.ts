/**
 * Vitest Unit Test Suite for Rolling Zero-Downtime Socket Drainage (`preStop` Lifecycle Handler)
 * Verifies /drain endpoint, /readyz 503 failover on SIGTERM/drain, rejection of new mutations,
 * and graceful completion of in-flight / parked connections within the 15-second grace window.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { DrainManager } from '../../src/server/drain.js';
import { ConnectionParkingLot } from '../../src/core/parking.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';

describe('Rolling Zero-Downtime Socket Drainage Engine', () => {
  let app: FastifyInstance;
  let parkingLot: ConnectionParkingLot;
  let drainManager: DrainManager;
  let mockTime: number;

  beforeEach(async () => {
    mockTime = 1_000_000;
    parkingLot = new ConnectionParkingLot();
    drainManager = new DrainManager({
      parkingLot,
      drainTimeoutMs: 15_000,
      checkIntervalMs: 10,
      clock: () => mockTime,
    });

    app = await buildApp({
      config: { LOG_LEVEL: 'silent' },
      storage: new MemoryStorageAdapter(),
      drainManager,
    });
  });

  afterEach(async () => {
    parkingLot.clear();
    await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  it('initializes in RUNNING state with /readyz returning HTTP 200', async () => {
    expect(drainManager.getState()).toBe('RUNNING');
    expect(drainManager.isDraining()).toBe(false);

    const readyRes = await app.inject({
      method: 'GET',
      url: '/readyz',
    });

    expect(readyRes.statusCode).toBe(200);
    const body = JSON.parse(readyRes.body);
    expect(body.status).toBe('ready');
  });

  it('transitions /readyz to HTTP 503 immediately when drainage is initiated', async () => {
    // Initiate drainage
    const drainPromise = drainManager.startDrain();

    // Verify /readyz fails to instantly shed Ingress traffic
    const readyRes = await app.inject({
      method: 'GET',
      url: '/readyz',
    });

    expect(readyRes.statusCode).toBe(503);
    const body = JSON.parse(readyRes.body);
    expect(body.status).toBe('draining');
    expect(body.message).toContain('draining active connections');

    await drainPromise;
  });

  it('rejects new incoming mutation requests with HTTP 503 and Retry-After: 2 during drainage', async () => {
    // Start drainage
    const drainPromise = drainManager.startDrain();

    // Attempt to invoke /v1/idempotency/begin
    const res = await app.inject({
      method: 'POST',
      url: '/v1/idempotency/begin',
      payload: {
        clientKey: 'tenant_1',
        idempotencyKey: 'order_123',
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.headers['connection']).toBe('close');
    const body = JSON.parse(res.body);
    expect(body.error).toBe('ServiceUnavailable');
    expect(body.message).toContain('Server is currently undergoing rolling maintenance');

    await drainPromise;
  });

  it('POST /drain endpoint triggers drainage and drains parked sockets gracefully', async () => {
    // Park a connection in parking lot
    const waitPromise = parkingLot.waitFor('tenant_1', 'order_drain', 10_000);
    expect(drainManager.getActiveSocketsCount()).toBe(1);

    // Call POST /drain
    const drainHttpPromise = app.inject({
      method: 'POST',
      url: '/drain',
    });

    // Unpark the socket via leader broadcast
    parkingLot.broadcast('tenant_1', 'order_drain', {
      statusCode: 200,
      body: { status: 'COMPLETED' },
    });

    await waitPromise;
    const drainResponse = await drainHttpPromise;

    expect(drainResponse.statusCode).toBe(200);
    const drainBody = JSON.parse(drainResponse.body);
    expect(drainBody.status).toBe('DRAINED');
    expect(drainBody.success).toBe(true);
    expect(drainBody.remainingSockets).toBe(0);
    expect(drainManager.getState()).toBe('DRAINED');
  });

  it('exits with remainingSockets count if grace period expires before all sockets drain', async () => {
    // Park a connection that never unparks
    parkingLot.waitFor('tenant_1', 'stuck_socket', 30_000);
    expect(drainManager.getActiveSocketsCount()).toBe(1);

    // Use fake clock advancing past 15,000ms deadline
    const customDrainManager = new DrainManager({
      parkingLot,
      drainTimeoutMs: 50,
      checkIntervalMs: 10,
    });

    const result = await customDrainManager.startDrain();
    expect(result.success).toBe(false);
    expect(result.remainingSockets).toBe(1);
    expect(customDrainManager.getState()).toBe('DRAINED');
  });
});
