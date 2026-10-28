/**
 * Unit Test Suite for Direct Idempotency Management REST API Routes
 * Tests /v1/idempotency/begin, /resolve, and /abort against TypeBox validation and storage states.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { computeStaticFingerprint } from '../../src/core/hasher.js';

describe('Direct Idempotency Management REST API Routes', () => {
  let app: FastifyInstance;
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter({ capacity: 1000 });
    app = await buildApp({
      config: { LOG_LEVEL: 'silent' },
      storage,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('POST /v1/idempotency/begin', () => {
    it('rejects malformed payload missing mandatory clientKey or idempotencyKey with HTTP 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload: {
          clientKey: 'tenant-123',
          // missing idempotencyKey
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Bad Request');
    });

    it('grants and acquires lock on fresh idempotency key with HTTP 200', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload: {
          clientKey: 'tenant-123',
          idempotencyKey: 'tx-req-001',
          method: 'POST',
          path: '/api/charge',
          payload: { amount: 5000, currency: 'USD' },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ACQUIRED');
      expect(body.fencingToken).toBeDefined();
    });

    it('returns HTTP 409 Conflict when a key is already in progress', async () => {
      const payload = {
        clientKey: 'tenant-123',
        idempotencyKey: 'tx-req-in-flight',
        method: 'POST',
        path: '/api/charge',
        payload: { amount: 2500 },
      };

      // First acquire succeeds
      const firstRes = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload,
      });
      expect(firstRes.statusCode).toBe(200);

      // Concurrent second acquire gets 409 Conflict
      const secondRes = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload,
      });
      expect(secondRes.statusCode).toBe(409);
      const body = JSON.parse(secondRes.body);
      expect(body.status).toBe('IN_PROGRESS');
    });

    it('returns HTTP 422 Unprocessable Entity on payload fingerprint mismatch', async () => {
      const key = 'tx-req-mismatch';
      const initialPayload = {
        clientKey: 'tenant-123',
        idempotencyKey: key,
        method: 'POST',
        path: '/api/charge',
        payload: { amount: 1000 },
      };

      await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload: initialPayload,
      });

      // Submit identical key with altered payload body
      const mismatchRes = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload: {
          clientKey: 'tenant-123',
          idempotencyKey: key,
          method: 'POST',
          path: '/api/charge',
          payload: { amount: 9999 }, // Tampered / divergent
        },
      });

      expect(mismatchRes.statusCode).toBe(422);
      const body = JSON.parse(mismatchRes.body);
      expect(body.status).toBe('MISMATCH');
      expect(body.expectedFingerprint).toBeDefined();
      expect(body.receivedFingerprint).toBeDefined();
      expect(body.expectedFingerprint).not.toBe(body.receivedFingerprint);
    });

    it('returns HTTP 200 with cached response if key is already resolved', async () => {
      const key = 'tx-req-cached';
      const clientKey = 'tenant-123';
      const payload = { orderId: 'ord-99' };

      // Step 1: Begin
      await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload: {
          clientKey,
          idempotencyKey: key,
          method: 'POST',
          path: '/orders',
          payload,
        },
      });

      // Step 2: Resolve
      await app.inject({
        method: 'POST',
        url: '/v1/idempotency/resolve',
        payload: {
          clientKey,
          idempotencyKey: key,
          statusCode: 201,
          headers: { 'x-tx-id': 'tx-777' },
          body: { success: true, orderId: 'ord-99' },
        },
      });

      // Step 3: Re-call begin with identical fingerprint
      const repeatRes = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload: {
          clientKey,
          idempotencyKey: key,
          method: 'POST',
          path: '/orders',
          payload,
        },
      });

      expect(repeatRes.statusCode).toBe(200);
      const body = JSON.parse(repeatRes.body);
      expect(body.status).toBe('CACHED');
      expect(body.response.statusCode).toBe(201);
      expect(body.response.headers['x-tx-id']).toBe('tx-777');
      expect(body.response.body.orderId).toBe('ord-99');
    });
  });

  describe('POST /v1/idempotency/resolve', () => {
    it('successfully transitions active lease to RESOLVED state', async () => {
      const clientKey = 'tenant-xyz';
      const idempotencyKey = 'tx-resolve-1';

      await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload: {
          clientKey,
          idempotencyKey,
        },
      });

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/resolve',
        payload: {
          clientKey,
          idempotencyKey,
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: { balance: 450.5 },
        },
      });

      expect(resolveRes.statusCode).toBe(200);
      const body = JSON.parse(resolveRes.body);
      expect(body.status).toBe('RESOLVED');

      const stored = await storage.get(clientKey, idempotencyKey);
      expect(stored?.status).toBe('RESOLVED');
      expect(stored?.responseStatus).toBe(200);
    });
  });

  describe('POST /v1/idempotency/abort', () => {
    it('successfully aborts an in-flight lease upon failure', async () => {
      const clientKey = 'tenant-xyz';
      const idempotencyKey = 'tx-abort-1';

      await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        payload: {
          clientKey,
          idempotencyKey,
        },
      });

      const abortRes = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/abort',
        payload: {
          clientKey,
          idempotencyKey,
          reason: 'Third-party gateway timeout (Stripe error 504)',
        },
      });

      expect(abortRes.statusCode).toBe(200);
      const body = JSON.parse(abortRes.body);
      expect(body.status).toBe('ABORTED');

      const stored = await storage.get(clientKey, idempotencyKey);
      expect(stored?.status).toBe('FAILED');
    });
  });
});
