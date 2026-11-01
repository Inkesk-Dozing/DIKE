/**
 * Test Suite: Error Status Code Handling & Non-Idempotent Failure Classification (Issue #55)
 * Validates classification rules:
 * - 2xx, 3xx, 400, 404, 422: Permanent / Cacheable (committed as RESOLVED)
 * - 500, 502, 503, 504, 408, 429, network timeouts/resets: Transient (aborted and evicted)
 * - Immediate client retry with the same key after transient failures
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import fastify, { FastifyInstance } from 'fastify';
import {
  ErrorStatusClassifier,
  defaultErrorClassifier,
} from '../../src/core/error_classifier.js';
import { executeIdempotentMutation } from '../../src/core/orchestrator.js';
import { ConnectionParkingLot } from '../../src/core/parking.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { transparentReverseProxy } from '../../src/proxy/handler.js';
import { IETF_IDEMPOTENCY_KEY_HEADER } from '../../src/server/plugins/ietf_headers.js';

describe('ErrorStatusClassifier Unit Tests', () => {
  const classifier = new ErrorStatusClassifier();

  it('classifies 2xx success codes as PERMANENT and cacheable', () => {
    for (const code of [200, 201, 202, 204]) {
      const decision = classifier.classifyStatus(code);
      expect(decision.classification).toBe('PERMANENT');
      expect(decision.isCacheable).toBe(true);
      expect(decision.shouldReleaseLease).toBe(false);
    }
  });

  it('classifies deterministic client errors (400, 401, 403, 404, 422) as PERMANENT and cacheable', () => {
    for (const code of [400, 401, 403, 404, 409, 410, 422]) {
      const decision = classifier.classifyStatus(code);
      expect(decision.classification).toBe('PERMANENT');
      expect(decision.isCacheable).toBe(true);
      expect(decision.shouldReleaseLease).toBe(false);
    }
  });

  it('classifies gateway/infrastructure errors (500, 502, 503, 504) as TRANSIENT and non-cacheable', () => {
    for (const code of [500, 502, 503, 504]) {
      const decision = classifier.classifyStatus(code);
      expect(decision.classification).toBe('TRANSIENT');
      expect(decision.isCacheable).toBe(false);
      expect(decision.shouldReleaseLease).toBe(true);
    }
  });

  it('classifies client rate limit (429) and request timeout (408) as TRANSIENT by default', () => {
    for (const code of [408, 429]) {
      const decision = classifier.classifyStatus(code);
      expect(decision.classification).toBe('TRANSIENT');
      expect(decision.isCacheable).toBe(false);
      expect(decision.shouldReleaseLease).toBe(true);
    }
  });

  it('classifies TCP socket errors and timeouts as TRANSIENT', () => {
    const connReset = { code: 'ECONNRESET', message: 'socket hang up' };
    const timedOut = { code: 'ETIMEDOUT', message: 'connection timed out' };
    const refused = { code: 'ECONNREFUSED', message: 'connection refused' };

    expect(classifier.classifyError(connReset).classification).toBe('TRANSIENT');
    expect(classifier.classifyError(timedOut).classification).toBe('TRANSIENT');
    expect(classifier.classifyError(refused).classification).toBe('TRANSIENT');
  });

  it('supports custom status overrides', () => {
    const custom = new ErrorStatusClassifier({
      extraPermanentStatuses: [500], // force 500 to be permanent
      extraTransientStatuses: [400], // force 400 to be transient
    });

    expect(custom.classifyStatus(500).classification).toBe('PERMANENT');
    expect(custom.classifyStatus(400).classification).toBe('TRANSIENT');
  });
});

describe('Orchestrator & Reverse Proxy Failure Handling', () => {
  let storage: MemoryStorageAdapter;
  let parkingLot: ConnectionParkingLot;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    parkingLot = new ConnectionParkingLot();
  });

  it('resolves and caches permanent 400 Bad Request error', async () => {
    const resolveSpy = vi.spyOn(storage, 'resolve');
    const abortSpy = vi.spyOn(storage, 'abort');

    const result = await executeIdempotentMutation({
      tenantId: 't1',
      key: 'key-err-400',
      storage,
      parkingLot,
      action: async () => ({
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: { error: 'InvalidAmount', message: 'Amount must be positive' },
      }),
    });

    expect(result.statusCode).toBe(400);
    expect(result.idempotencyStatus).toBe('MISS');
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).not.toHaveBeenCalled();

    // Replay should return CACHED 400
    const replay = await executeIdempotentMutation({
      tenantId: 't1',
      key: 'key-err-400',
      storage,
      parkingLot,
      action: async () => {
        throw new Error('Should not be executed on replay');
      },
    });

    expect(replay.statusCode).toBe(400);
    expect(replay.idempotencyStatus).toBe('HIT');
    expect((replay.body as any).error).toBe('InvalidAmount');
  });

  it('aborts and releases lease on 503 Unavailable, allowing immediate retry with same key', async () => {
    const resolveSpy = vi.spyOn(storage, 'resolve');
    const abortSpy = vi.spyOn(storage, 'abort');

    // First attempt: Upstream returns 503 (Transient)
    const result1 = await executeIdempotentMutation({
      tenantId: 't1',
      key: 'key-err-503',
      storage,
      parkingLot,
      action: async () => ({
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: { error: 'ServiceUnavailable' },
      }),
    });

    expect(result1.statusCode).toBe(503);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(abortSpy).toHaveBeenCalledTimes(1);

    // Second attempt: Client retries with EXACT same key immediately
    const result2 = await executeIdempotentMutation({
      tenantId: 't1',
      key: 'key-err-503',
      storage,
      parkingLot,
      action: async () => ({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: { status: 'success_on_retry' },
      }),
    });

    expect(result2.statusCode).toBe(200);
    expect(result2.idempotencyStatus).toBe('MISS'); // Fresh execution on retry!
    expect((result2.body as any).status).toBe('success_on_retry');
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });
});
