/**
 * Unit Test Suite for IETF Idempotency-Key Standard HTTP Header Compliance
 * Tests draft-ietf-httpapi-idempotency-key-header-05 specification conformance.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import {
  validateIdempotencyKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  IETF_IDEMPOTENCY_KEY_HEADER,
  IETF_IDEMPOTENCY_STATUS_HEADER,
  IETF_IDEMPOTENCY_REPLAYED_AT_HEADER,
} from '../../src/server/plugins/ietf_headers.js';

describe('IETF Idempotency-Key Standard Compliance', () => {
  describe('validateIdempotencyKey Helper', () => {
    it('validates standard alphanumeric and printable ASCII keys', () => {
      expect(validateIdempotencyKey('req_123456789_abc').valid).toBe(true);
      expect(validateIdempotencyKey('UUID-8a17e144-c10f-4971-a09f-812dec98d96e').valid).toBe(true);
      expect(validateIdempotencyKey('a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH)).valid).toBe(true);
    });

    it('rejects empty or whitespace-only keys', () => {
      expect(validateIdempotencyKey('').valid).toBe(false);
    });

    it('rejects keys exceeding maximum permitted length (255 characters)', () => {
      const oversized = 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);
      const res = validateIdempotencyKey(oversized);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('exceeds maximum permitted limit');
    });

    it('rejects keys with illegal control characters or non-ASCII characters', () => {
      expect(validateIdempotencyKey('key\nwith-newline').valid).toBe(false);
      expect(validateIdempotencyKey('key\x00with-nullbyte').valid).toBe(false);
      expect(validateIdempotencyKey('key-with-emoji-🚀').valid).toBe(false);
    });
  });

  describe('Fastify Middleware & Header Lifecycle', () => {
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

    it('allows requests without Idempotency-Key header to pass cleanly', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers[IETF_IDEMPOTENCY_STATUS_HEADER]).toBeUndefined();
    });

    it('rejects request with HTTP 400 when Idempotency-Key exceeds length limit', async () => {
      const invalidKey = 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 5);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        headers: {
          [IETF_IDEMPOTENCY_KEY_HEADER]: invalidKey,
        },
        payload: {
          clientKey: 'tenant-test',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('BadRequest');
      expect(body.message).toContain('exceeds maximum permitted limit');
    });

    it('rejects request with HTTP 400 when Idempotency-Key contains illegal characters', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        headers: {
          [IETF_IDEMPOTENCY_KEY_HEADER]: 'bad\r\nkey',
        },
        payload: {
          clientKey: 'tenant-test',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('BadRequest');
    });

    it('injects Idempotency-Status: MISS on fresh execution', async () => {
      const key = 'fresh-tx-key-101';
      const response = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        headers: {
          [IETF_IDEMPOTENCY_KEY_HEADER]: key,
        },
        payload: {
          clientKey: 'tenant-header-test',
          method: 'POST',
          path: '/orders',
          payload: { item: 'book' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers[IETF_IDEMPOTENCY_STATUS_HEADER]).toBe('MISS');
      expect(response.headers[IETF_IDEMPOTENCY_REPLAYED_AT_HEADER]).toBeUndefined();
    });

    it('injects Idempotency-Status: HIT and Idempotency-Replayed-At on cached response playback', async () => {
      const key = 'cached-tx-key-202';
      const clientKey = 'tenant-header-test';

      // 1. Begin with header
      await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        headers: {
          [IETF_IDEMPOTENCY_KEY_HEADER]: key,
        },
        payload: {
          clientKey,
          method: 'POST',
          path: '/orders',
          payload: { item: 'laptop' },
        },
      });

      // 2. Resolve
      await app.inject({
        method: 'POST',
        url: '/v1/idempotency/resolve',
        headers: {
          [IETF_IDEMPOTENCY_KEY_HEADER]: key,
        },
        payload: {
          clientKey,
          statusCode: 201,
          body: { orderId: 'laptop-99' },
        },
      });

      // 3. Repeat identical request
      const replayResponse = await app.inject({
        method: 'POST',
        url: '/v1/idempotency/begin',
        headers: {
          [IETF_IDEMPOTENCY_KEY_HEADER]: key,
        },
        payload: {
          clientKey,
          method: 'POST',
          path: '/orders',
          payload: { item: 'laptop' },
        },
      });

      expect(replayResponse.statusCode).toBe(200);
      expect(replayResponse.headers[IETF_IDEMPOTENCY_STATUS_HEADER]).toBe('HIT');
      expect(replayResponse.headers[IETF_IDEMPOTENCY_REPLAYED_AT_HEADER]).toBeDefined();
      const replayedDate = new Date(replayResponse.headers[IETF_IDEMPOTENCY_REPLAYED_AT_HEADER] as string);
      expect(isNaN(replayedDate.getTime())).toBe(false);
    });
  });
});
