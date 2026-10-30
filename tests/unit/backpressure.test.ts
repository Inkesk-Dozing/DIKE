/**
 * Vitest Unit Test Suite for Adaptive Backpressure Controller
 * Validates connection shedding during flash crowds, HTTP 429 status code emission,
 * Retry-After header generation, and server heap safety under 10,000 requests.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionParkingLot } from '../../src/core/parking.js';
import {
  AdaptiveBackpressureController,
  BackpressureExceededError,
  defaultBackpressureController,
} from '../../src/core/backpressure.js';

describe('Adaptive Backpressure Controller for Parked Connections', () => {
  let parkingLot: ConnectionParkingLot;

  beforeEach(() => {
    parkingLot = new ConnectionParkingLot({
      defaultTimeoutMs: 15_000,
      maxParkedPerKey: 500,
      maxTotalParked: 50_000,
    });
  });

  afterEach(() => {
    parkingLot.clear();
    vi.restoreAllMocks();
  });

  it('initializes controller with custom and default configurations', () => {
    const controller = new AdaptiveBackpressureController({
      maxParkedPerKey: 250,
      maxTotalParked: 10_000,
      retryAfterSeconds: 5,
    });

    expect(controller.maxParkedPerKey).toBe(250);
    expect(controller.maxTotalParked).toBe(10_000);
    expect(controller.retryAfterSeconds).toBe(5);

    expect(defaultBackpressureController.maxParkedPerKey).toBe(500);
    expect(defaultBackpressureController.maxTotalParked).toBe(50_000);
    expect(defaultBackpressureController.retryAfterSeconds).toBe(2);
  });

  it('allows connections when current parked sockets are under threshold', () => {
    const controller = new AdaptiveBackpressureController({
      maxParkedPerKey: 10,
    });

    const result = controller.evaluate(parkingLot, 'tenant_1', 'key_1');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('OK');
    expect(result.currentKeyParked).toBe(0);

    expect(() => controller.assertCapacity(parkingLot, 'tenant_1', 'key_1')).not.toThrow();
  });

  it('sheds connections and returns KEY_LIMIT_EXCEEDED when per-key limit is reached', () => {
    const controller = new AdaptiveBackpressureController({
      maxParkedPerKey: 5,
      retryAfterSeconds: 2,
    });

    // Fill parking lot to limit
    for (let i = 0; i < 5; i++) {
      parkingLot.waitFor('tenant_1', 'key_crowd');
    }

    expect(parkingLot.getParkedCount('tenant_1', 'key_crowd')).toBe(5);

    const evaluation = controller.evaluate(parkingLot, 'tenant_1', 'key_crowd');
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reason).toBe('KEY_LIMIT_EXCEEDED');
    expect(evaluation.retryAfterSeconds).toBe(2);

    expect(() => controller.assertCapacity(parkingLot, 'tenant_1', 'key_crowd')).toThrow(
      BackpressureExceededError
    );

    try {
      controller.assertCapacity(parkingLot, 'tenant_1', 'key_crowd');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BackpressureExceededError);
      expect(err.statusCode).toBe(429);
      expect(err.retryAfter).toBe(2);
      expect(err.key).toBe('key_crowd');
      expect(err.tenantId).toBe('tenant_1');

      const json = err.toJSON();
      expect(json.statusCode).toBe(429);
      expect(json.error).toBe('TooManyRequests');
      expect(json.retryAfter).toBe(2);
      expect(json.message).toContain('Per-key concurrency limit of 5');
    }
  });

  it('sheds connections and returns GLOBAL_LIMIT_EXCEEDED when node global limit is reached', () => {
    const controller = new AdaptiveBackpressureController({
      maxParkedPerKey: 500,
      maxTotalParked: 3,
      retryAfterSeconds: 3,
    });

    parkingLot.waitFor('tenant_a', 'key_1');
    parkingLot.waitFor('tenant_b', 'key_2');
    parkingLot.waitFor('tenant_c', 'key_3');

    expect(parkingLot.getTotalParkedCount()).toBe(3);

    const evaluation = controller.evaluate(parkingLot, 'tenant_d', 'key_4');
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reason).toBe('GLOBAL_LIMIT_EXCEEDED');
    expect(evaluation.retryAfterSeconds).toBe(3);

    expect(() => controller.assertCapacity(parkingLot, 'tenant_d', 'key_4')).toThrow(
      /Global concurrency limit of 3/
    );
  });

  it('resumes accepting requests once leader resolves and parked sockets unpark', () => {
    const controller = new AdaptiveBackpressureController({
      maxParkedPerKey: 3,
    });

    parkingLot.waitFor('tenant_1', 'key_burst');
    parkingLot.waitFor('tenant_1', 'key_burst');
    parkingLot.waitFor('tenant_1', 'key_burst');

    expect(controller.evaluate(parkingLot, 'tenant_1', 'key_burst').allowed).toBe(false);

    // Leader broadcasts resolution
    parkingLot.broadcast('tenant_1', 'key_burst', {
      statusCode: 200,
      body: { ok: true },
    });

    expect(parkingLot.getParkedCount('tenant_1', 'key_burst')).toBe(0);
    expect(controller.evaluate(parkingLot, 'tenant_1', 'key_burst').allowed).toBe(true);
  });

  it('handles simulated flash crowd of 10,000 requests without node failure', () => {
    const controller = new AdaptiveBackpressureController({
      maxParkedPerKey: 500,
      retryAfterSeconds: 2,
    });

    let allowedCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < 10_000; i++) {
      const evaluation = controller.evaluate(parkingLot, 'flash_tenant', 'flash_key');
      if (evaluation.allowed) {
        parkingLot.waitFor('flash_tenant', 'flash_key');
        allowedCount++;
      } else {
        rejectedCount++;
      }
    }

    expect(allowedCount).toBe(500);
    expect(rejectedCount).toBe(9_500);
    expect(parkingLot.getParkedCount('flash_tenant', 'flash_key')).toBe(500);
  });
});
