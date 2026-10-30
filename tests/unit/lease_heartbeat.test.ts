/**
 * Vitest Unit Test Suite for LeaseHeartbeatTimer & withLeaseHeartbeat
 * Verifies periodic renewal, hard ceilings, deadman worker termination, and fencing token protection.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LeaseHeartbeatTimer, withLeaseHeartbeat } from '../../src/core/lease_heartbeat.js';
import { formatClusterHashTag } from '../../src/storage/redis_pool.js';

describe('LeaseHeartbeatTimer Unit Tests', () => {
  let mockRedisData: Map<string, string>;
  let mockPexpireData: Map<string, number>;
  let mockRedisClient: any;
  let mockTime: number;

  beforeEach(() => {
    mockTime = 1000000;
    mockRedisData = new Map();
    mockPexpireData = new Map();

    mockRedisClient = {
      get: vi.fn(async (key: string) => mockRedisData.get(key) || null),
      set: vi.fn(async (key: string, val: string) => {
        mockRedisData.set(key, val);
        return 'OK';
      }),
      pexpire: vi.fn(async (key: string, ttl: number) => {
        if (mockRedisData.has(key) || key.endsWith(':fence')) {
          mockPexpireData.set(key, ttl);
          return 1;
        }
        return 0;
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with default options and calculates interval as TTL/3', () => {
    const timer = new LeaseHeartbeatTimer({
      tenantId: 'tenant_alpha',
      key: 'order_123',
      client: mockRedisClient,
      leaseTtlMs: 15000,
    });

    expect(timer.tenantId).toBe('tenant_alpha');
    expect(timer.key).toBe('order_123');
    expect(timer.leaseTtlMs).toBe(15000);
    expect(timer.heartbeatIntervalMs).toBe(5000);
    expect(timer.maxCeilingMs).toBe(60000);
    expect(timer.getStatus()).toBe('IDLE');
  });

  it('rejects missing tenantId, key, or redis client', () => {
    expect(() => new LeaseHeartbeatTimer({ tenantId: '', key: 'k', client: mockRedisClient })).toThrow();
    expect(() => new LeaseHeartbeatTimer({ tenantId: 't', key: '', client: mockRedisClient })).toThrow();
    expect(() => new LeaseHeartbeatTimer({ tenantId: 't', key: 'k', client: null as any })).toThrow();
  });

  it('extends lease when record is in STARTED state and within max ceiling', async () => {
    const recordKey = formatClusterHashTag('tenant_1', 'key_1');
    const initialRecord = {
      id: 'rec_1',
      status: 'STARTED',
      fencingToken: '10',
      lockedUntilMs: mockTime + 15000,
      createdAt: new Date(mockTime).toISOString(),
    };
    mockRedisData.set(recordKey, JSON.stringify(initialRecord));

    const timer = new LeaseHeartbeatTimer({
      tenantId: 'tenant_1',
      key: 'key_1',
      client: mockRedisClient,
      leaseTtlMs: 15000,
      heartbeatIntervalMs: 5000,
      maxCeilingMs: 60000,
      fencingToken: 10n,
      clock: () => mockTime,
    });

    timer.start();
    expect(timer.getStatus()).toBe('RUNNING');

    // Simulate 5s elapsed
    mockTime += 5000;
    const renewed = await timer.renewNow();

    expect(renewed).toBe(true);
    expect(timer.getRenewalsCount()).toBe(1);

    const savedRaw = mockRedisData.get(recordKey)!;
    const parsed = JSON.parse(savedRaw);
    expect(parsed.lockedUntilMs).toBe(mockTime + 15000);

    timer.stop();
    expect(timer.getStatus()).toBe('STOPPED');
  });

  it('refuses renewal and flags CEILING_REACHED when elapsed time exceeds max ceiling', async () => {
    const recordKey = formatClusterHashTag('tenant_1', 'key_1');
    mockRedisData.set(recordKey, JSON.stringify({ status: 'STARTED' }));

    const timer = new LeaseHeartbeatTimer({
      tenantId: 'tenant_1',
      key: 'key_1',
      client: mockRedisClient,
      leaseTtlMs: 15000,
      maxCeilingMs: 30000,
      clock: () => mockTime,
    });

    timer.start();

    // Advance beyond ceiling: 20s + 15s leaseTtl > 30s ceiling
    mockTime += 20000;
    const renewed = await timer.renewNow();

    expect(renewed).toBe(false);
    expect(timer.getStatus()).toBe('CEILING_REACHED');
  });

  it('refuses renewal if record has already resolved or aborted', async () => {
    const recordKey = formatClusterHashTag('tenant_1', 'key_1');
    mockRedisData.set(recordKey, JSON.stringify({ status: 'RESOLVED' }));

    const timer = new LeaseHeartbeatTimer({
      tenantId: 'tenant_1',
      key: 'key_1',
      client: mockRedisClient,
      clock: () => mockTime,
    });

    timer.start();
    const renewed = await timer.renewNow();

    expect(renewed).toBe(false);
    expect(timer.getStatus()).toBe('EXPIRED');
  });

  it('refuses renewal if record is missing (deadman cleanup happened)', async () => {
    const timer = new LeaseHeartbeatTimer({
      tenantId: 'tenant_1',
      key: 'missing_key',
      client: mockRedisClient,
      clock: () => mockTime,
    });

    timer.start();
    const renewed = await timer.renewNow();

    expect(renewed).toBe(false);
    expect(timer.getStatus()).toBe('EXPIRED');
  });

  it('refuses renewal if fencing token is mismatched (zombie writer prevention)', async () => {
    const recordKey = formatClusterHashTag('tenant_1', 'key_1');
    mockRedisData.set(
      recordKey,
      JSON.stringify({
        status: 'STARTED',
        fencingToken: '15', // newer fencing token acquired by another worker
      }),
    );

    const timer = new LeaseHeartbeatTimer({
      tenantId: 'tenant_1',
      key: 'key_1',
      client: mockRedisClient,
      fencingToken: '10', // old token
      clock: () => mockTime,
    });

    timer.start();
    const renewed = await timer.renewNow();

    expect(renewed).toBe(false);
    expect(timer.getStatus()).toBe('EXPIRED');
  });

  it('halts heartbeat immediately if health check fails or throws', async () => {
    const recordKey = formatClusterHashTag('tenant_1', 'key_1');
    mockRedisData.set(recordKey, JSON.stringify({ status: 'STARTED' }));

    let isHealthy = false;
    const timer = new LeaseHeartbeatTimer({
      tenantId: 'tenant_1',
      key: 'key_1',
      client: mockRedisClient,
      healthCheck: () => isHealthy,
      clock: () => mockTime,
    });

    timer.start();
    const renewed = await timer.renewNow();
    expect(renewed).toBe(false);
    expect(timer.getStatus()).toBe('ERROR');

    // Throws test
    const throwingTimer = new LeaseHeartbeatTimer({
      tenantId: 'tenant_1',
      key: 'key_1',
      client: mockRedisClient,
      healthCheck: () => {
        throw new Error('Unhealthy condition detected');
      },
      clock: () => mockTime,
    });

    throwingTimer.start();
    const renewedThrow = await throwingTimer.renewNow();
    expect(renewedThrow).toBe(false);
    expect(throwingTimer.getStatus()).toBe('ERROR');
  });

  it('withLeaseHeartbeat executes async task and stops heartbeat on completion', async () => {
    const recordKey = formatClusterHashTag('tenant_1', 'key_1');
    mockRedisData.set(recordKey, JSON.stringify({ status: 'STARTED' }));

    let capturedTimer: LeaseHeartbeatTimer | null = null;

    const result = await withLeaseHeartbeat(
      {
        tenantId: 'tenant_1',
        key: 'key_1',
        client: mockRedisClient,
        clock: () => mockTime,
      },
      async (t) => {
        capturedTimer = t;
        expect(t.getStatus()).toBe('RUNNING');
        return 'COMPLETED_PAYLOAD';
      },
    );

    expect(result).toBe('COMPLETED_PAYLOAD');
    expect(capturedTimer).not.toBeNull();
    expect(capturedTimer!.getStatus()).toBe('STOPPED');
  });
});
