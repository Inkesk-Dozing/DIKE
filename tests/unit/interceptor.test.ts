/**
 * Test Suite: Selective Idempotency Interception & Pass-Through Pipeline (Issue #50)
 * Verifies safe method bypass, absent key pass-through, strict-mode enforcement,
 * and seamless integration with Fastify transparent reverse proxy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import fastify, { FastifyInstance } from 'fastify';
import { IdempotencyInterceptor } from '../../src/proxy/interceptor.js';
import { transparentReverseProxy } from '../../src/proxy/handler.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { IETF_IDEMPOTENCY_KEY_HEADER } from '../../src/server/plugins/ietf_headers.js';

describe('IdempotencyInterceptor Unit Tests', () => {
  it('should bypass safe HTTP methods (GET, HEAD, OPTIONS, DELETE, TRACE)', () => {
    const interceptor = new IdempotencyInterceptor();

    const safeMethods = ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'TRACE'];
    for (const method of safeMethods) {
      const mockReq = {
        url: '/api/v1/orders/123',
        method,
        headers: { [IETF_IDEMPOTENCY_KEY_HEADER]: 'key-safe-123' },
      } as any;

      const decision = interceptor.evaluate(mockReq, true);
      expect(decision).toEqual({
        action: 'BYPASS',
        reason: 'SAFE_OR_IDEMPOTENT_METHOD',
      });
    }
  });

  it('should bypass internal excluded paths regardless of method or key', () => {
    const interceptor = new IdempotencyInterceptor();

    const excluded = ['/healthz', '/readyz', '/drain', '/v1/idempotency/begin'];
    for (const path of excluded) {
      const mockReq = {
        url: path,
        method: 'POST',
        headers: { [IETF_IDEMPOTENCY_KEY_HEADER]: 'key-health-123' },
      } as any;

      const decision = interceptor.evaluate(mockReq, true);
      expect(decision).toEqual({
        action: 'BYPASS',
        reason: 'EXCLUDED_PATH',
      });
    }
  });

  it('should bypass mutation request without Idempotency-Key when strict mode is disabled', () => {
    const interceptor = new IdempotencyInterceptor({ strictMode: false });

    const mockReq = {
      url: '/api/v1/checkout',
      method: 'POST',
      headers: {},
    } as any;

    const decision = interceptor.evaluate(mockReq, true);
    expect(decision).toEqual({
      action: 'BYPASS',
      reason: 'MISSING_KEY_NON_STRICT',
    });
  });

  it('should reject mutation request without Idempotency-Key when strict mode is enabled', () => {
    const interceptor = new IdempotencyInterceptor({ strictMode: true });

    const mutations = ['POST', 'PUT', 'PATCH'];
    for (const method of mutations) {
      const mockReq = {
        url: '/api/v1/checkout',
        method,
        headers: {},
      } as any;

      const decision = interceptor.evaluate(mockReq, true);
      expect(decision).toEqual({
        action: 'REJECT',
        statusCode: 400,
        message: `Idempotency-Key header is required for mutation method ${method} when strict mode is enabled.`,
      });
    }
  });

  it('should bypass if storage engine is unavailable', () => {
    const interceptor = new IdempotencyInterceptor();

    const mockReq = {
      url: '/api/v1/checkout',
      method: 'POST',
      headers: { [IETF_IDEMPOTENCY_KEY_HEADER]: 'valid-key-999' },
    } as any;

    const decision = interceptor.evaluate(mockReq, false);
    expect(decision).toEqual({
      action: 'BYPASS',
      reason: 'NO_STORAGE',
    });
  });

  it('should successfully intercept mutation with valid Idempotency-Key and extract tenant', () => {
    const interceptor = new IdempotencyInterceptor();

    const mockReq = {
      url: '/api/v1/checkout',
      method: 'POST',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: 'tx-abc-123',
        'x-client-id': 'tenant-finance-42',
      },
    } as any;

    const decision = interceptor.evaluate(mockReq, true);
    expect(decision).toEqual({
      action: 'INTERCEPT',
      key: 'tx-abc-123',
      tenantId: 'tenant-finance-42',
    });
  });

  it('should fallback to default tenant if tenant headers are absent', () => {
    const interceptor = new IdempotencyInterceptor();

    const mockReq = {
      url: '/api/v1/checkout',
      method: 'POST',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: 'tx-abc-123',
      },
    } as any;

    const decision = interceptor.evaluate(mockReq, true);
    expect(decision).toEqual({
      action: 'INTERCEPT',
      key: 'tx-abc-123',
      tenantId: 'default_tenant',
    });
  });
});

describe('Selective Idempotency Integration with Reverse Proxy Pipeline', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let upstreamCallCount: number;
  let proxyApp: FastifyInstance;
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    upstreamCallCount = 0;

    upstreamServer = http.createServer((req, res) => {
      upstreamCallCount++;
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Upstream-Echo', req.url ?? '');
        res.writeHead(200);
        res.end(
          JSON.stringify({
            status: 'ok',
            method: req.method,
            callIndex: upstreamCallCount,
            receivedBody: body ? JSON.parse(body) : null,
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        const addr = upstreamServer.address() as any;
        upstreamPort = addr.port;
        resolve();
      });
    });

    storage = new MemoryStorageAdapter();
  });

  afterEach(async () => {
    if (proxyApp) {
      await proxyApp.close();
    }
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it('GET requests bypass idempotency storage engine completely', async () => {
    const storageSpy = vi.spyOn(storage, 'get');

    proxyApp = fastify({ logger: false });
    await proxyApp.register(transparentReverseProxy, {
      upstream: { targetUrl: `http://127.0.0.1:${upstreamPort}` },
      storage,
    });
    await proxyApp.ready();

    const res = await proxyApp.inject({
      method: 'GET',
      url: '/api/items?limit=10',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: 'get-key-should-be-ignored',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(upstreamCallCount).toBe(1);
    expect(storageSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(res.body);
    expect(parsed.method).toBe('GET');
  });

  it('POST requests without Idempotency-Key pass through when strictMode is false', async () => {
    proxyApp = fastify({ logger: false });
    await proxyApp.register(transparentReverseProxy, {
      upstream: { targetUrl: `http://127.0.0.1:${upstreamPort}` },
      storage,
      interceptorOptions: { strictMode: false },
    });
    await proxyApp.ready();

    const res = await proxyApp.inject({
      method: 'POST',
      url: '/api/unprotected-mutation',
      headers: {
        'content-type': 'application/json',
      },
      payload: { action: 'ping' },
    });

    expect(res.statusCode).toBe(200);
    expect(upstreamCallCount).toBe(1);
    const parsed = JSON.parse(res.body);
    expect(parsed.callIndex).toBe(1);
  });

  it('POST requests without Idempotency-Key are rejected with 400 when strictMode is true', async () => {
    proxyApp = fastify({ logger: false });
    await proxyApp.register(transparentReverseProxy, {
      upstream: { targetUrl: `http://127.0.0.1:${upstreamPort}` },
      storage,
      interceptorOptions: { strictMode: true },
    });
    await proxyApp.ready();

    const res = await proxyApp.inject({
      method: 'POST',
      url: '/api/strict-mutation',
      headers: {
        'content-type': 'application/json',
      },
      payload: { action: 'charge' },
    });

    expect(res.statusCode).toBe(400);
    expect(upstreamCallCount).toBe(0);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe('Bad Request');
    expect(parsed.message).toContain('strict mode is enabled');
  });

  it('POST requests with Idempotency-Key are intercepted and cached idempotently', async () => {
    proxyApp = fastify({ logger: false });
    await proxyApp.register(transparentReverseProxy, {
      upstream: { targetUrl: `http://127.0.0.1:${upstreamPort}` },
      storage,
    });
    await proxyApp.ready();

    const mutationKey = 'idem-transact-999';

    // First Call: Fresh Execution
    const res1 = await proxyApp.inject({
      method: 'POST',
      url: '/api/payment',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: mutationKey,
        'content-type': 'application/json',
      },
      payload: { amount: 100, currency: 'USD' },
    });

    expect(res1.statusCode).toBe(200);
    expect(upstreamCallCount).toBe(1);
    const body1 = JSON.parse(res1.body);
    expect(body1.callIndex).toBe(1);

    // Second Call: Cached Idempotent Replay
    const res2 = await proxyApp.inject({
      method: 'POST',
      url: '/api/payment',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: mutationKey,
        'content-type': 'application/json',
      },
      payload: { amount: 100, currency: 'USD' },
    });

    expect(res2.statusCode).toBe(200);
    expect(upstreamCallCount).toBe(1); // Zero additional upstream hits!
    const body2 = JSON.parse(res2.body);
    expect(body2.callIndex).toBe(1); // Exactly replayed from cache
  });
});
