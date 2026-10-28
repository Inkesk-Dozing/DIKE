import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { IIdempotencyStorage } from '../../src/storage/interface.js';

describe('Fastify Server Architecture & Plugin Pipeline', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Configuration Engine (loadConfig)', () => {
    it('loads standard default configurations', () => {
      const config = loadConfig({});
      expect(config.PORT).toBe(3000);
      expect(config.HOST).toBe('0.0.0.0');
      expect(config.NODE_ENV).toBe('development');
      expect(config.DATABASE_POOL_MAX).toBe(20);
      expect(config.IDEMPOTENCY_LOCK_TIMEOUT_MS).toBe(30_000);
    });

    it('parses numeric and string environment overrides correctly', () => {
      const config = loadConfig({
        PORT: '8080',
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
        DATABASE_POOL_MAX: '50',
      });
      expect(config.PORT).toBe(8080);
      expect(config.HOST).toBe('127.0.0.1');
      expect(config.NODE_ENV).toBe('production');
      expect(config.LOG_LEVEL).toBe('warn');
      expect(config.DATABASE_POOL_MAX).toBe(50);
    });
  });

  describe('HTTP Endpoints & Probes', () => {
    it('responds to /healthz liveness probe with HTTP 200', async () => {
      app = await buildApp({ config: { LOG_LEVEL: 'silent' } });

      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(typeof body.uptime).toBe('number');
      expect(body.timestamp).toBeDefined();
    });

    it('responds to /readyz readiness probe with HTTP 200 when storage is ready', async () => {
      const mockStorage: IIdempotencyStorage = {
        acquire: vi.fn(),
        resolve: vi.fn(),
        abort: vi.fn(),
        get: vi.fn(),
        evict: vi.fn(),
        close: vi.fn(),
      };

      app = await buildApp({
        config: { LOG_LEVEL: 'silent' },
        storage: mockStorage,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/readyz',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ready');
      expect(body.checks.storage).toBe('up');
    });

    it('returns HTTP 503 on /readyz when storage health check fails', async () => {
      const mockStorage = {
        acquire: vi.fn(),
        resolve: vi.fn(),
        abort: vi.fn(),
        get: vi.fn(),
        evict: vi.fn(),
        close: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue(false),
      } as unknown as IIdempotencyStorage;

      app = await buildApp({
        config: { LOG_LEVEL: 'silent' },
        storage: mockStorage,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/readyz',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('unhealthy');
      expect(body.checks.storage).toBe('down');
    });

    it('returns structured 404 error envelope on undefined routes', async () => {
      app = await buildApp({ config: { LOG_LEVEL: 'silent' } });

      const response = await app.inject({
        method: 'GET',
        url: '/non-existent-endpoint',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('NotFoundError');
      expect(body.statusCode).toBe(404);
      expect(body.message).toContain('not found');
      expect(body.timestamp).toBeDefined();
    });

    it('applies security headers via helmet plugin', async () => {
      app = await buildApp({ config: { LOG_LEVEL: 'silent' } });

      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    });
  });
});
