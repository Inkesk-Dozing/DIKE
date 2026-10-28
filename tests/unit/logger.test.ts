/**
 * Unit Test Suite for Structured Logging & Zero-Secret Redaction
 * Tests sensitive payload masking, trace ID propagation, and Pino serializer security.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { buildApp } from '../../src/server/app.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { createLogger, generateTraceId, REDACTED_MASK } from '../../src/utils/logger.js';

describe('Structured Logging with Zero-Secret Redaction', () => {
  describe('Standalone Pino Logger Instance', () => {
    it('redacts sensitive credentials and PII fields in JSON stream', () => {
      let loggedOutput = '';
      const destination = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          loggedOutput += chunk.toString();
          callback();
        },
      });

      const logger = createLogger({
        level: 'info',
        destination,
      });

      logger.info({
        password: 'super-secret-password-123',
        creditCard: '4111-2222-3333-4444',
        token: 'eyJh...jwt-secret',
        safeField: 'harmless-order-data',
      }, 'Processing payment transaction');

      expect(loggedOutput).toContain(REDACTED_MASK);
      expect(loggedOutput).not.toContain('super-secret-password-123');
      expect(loggedOutput).not.toContain('4111-2222-3333-4444');
      expect(loggedOutput).not.toContain('eyJh...jwt-secret');
      expect(loggedOutput).toContain('harmless-order-data');

      const parsed = JSON.parse(loggedOutput.trim());
      expect(parsed.password).toBe(REDACTED_MASK);
      expect(parsed.creditCard).toBe(REDACTED_MASK);
      expect(parsed.token).toBe(REDACTED_MASK);
      expect(parsed.safeField).toBe('harmless-order-data');
    });

    it('generates compliant RFC 4122 v4 trace IDs', () => {
      const traceId = generateTraceId();
      expect(typeof traceId).toBe('string');
      expect(traceId.length).toBe(36);
      expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });

  describe('Fastify Server Logging & Trace ID Correlation', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildApp({
        config: { LOG_LEVEL: 'silent' },
        storage: new MemoryStorageAdapter({ capacity: 100 }),
      });
      await app.ready();
    });

    afterEach(async () => {
      if (app) {
        await app.close();
      }
    });

    it('injects x-trace-id header into HTTP responses', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.statusCode).toBe(200);
      const traceId = response.headers['x-trace-id'];
      expect(traceId).toBeDefined();
      expect(typeof traceId).toBe('string');
      expect((traceId as string).length).toBe(36);
    });

    it('preserves incoming x-trace-id header if provided by caller', async () => {
      const customTraceId = 'external-trace-uuid-12345';
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: {
          'x-trace-id': customTraceId,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-trace-id']).toBe(customTraceId);
    });
  });
});
