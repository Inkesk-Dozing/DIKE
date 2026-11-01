/**
 * Test Suite: HTTP 304 Not Modified & ETag Co-Existence Handler (Issue #56)
 * Validates:
 * - 304 response preserves existing cached payload in storage rather than overwriting with empty body.
 * - ETags preserved on replayed responses.
 * - Client If-None-Match conditional evaluations returning 304 on cache hits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fastify, { FastifyInstance } from 'fastify';
import { ETagCoexistenceHandler } from '../../src/proxy/etag_handler.js';
import { transparentReverseProxy } from '../../src/proxy/handler.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { IETF_IDEMPOTENCY_KEY_HEADER } from '../../src/server/plugins/ietf_headers.js';

describe('ETagCoexistenceHandler Unit Tests', () => {
  const handler = new ETagCoexistenceHandler();

  it('preserves existing storage body when upstream returns 304 Not Modified', () => {
    const existingRecord = {
      tenantId: 'tenant_1',
      idempotencyKey: 'key_1',
      requestFingerprint: 'fp_1',
      state: 'RESOLVED',
      createdAt: 1000,
      updatedAt: 1000,
      expireAt: 5000,
      responseStatus: 200,
      responseHeaders: { etag: '"v1-hash-1234"', 'content-type': 'application/json' },
      responseBody: { account: 'acc_999', balance: 5000 },
    } as any;

    const evalResult = handler.evaluateResponse(
      304,
      { etag: '"v1-hash-1234"' },
      '', // Upstream returns empty body for 304
      existingRecord
    );

    expect(evalResult.statusCode).toBe(304);
    expect(evalResult.body).toBe(''); // Client receives 304 empty body
    expect(evalResult.bodyToPersist).toEqual({ account: 'acc_999', balance: 5000 }); // Storage body retained!
  });

  it('evaluates If-None-Match replay header matches returning 304', () => {
    const record = {
      tenantId: 'tenant_1',
      idempotencyKey: 'key_1',
      requestFingerprint: 'fp_1',
      state: 'RESOLVED',
      createdAt: 1000,
      updatedAt: 1000,
      expireAt: 5000,
      responseStatus: 200,
      responseHeaders: { etag: '"hash-abc-789"' },
      responseBody: { data: 'test' },
    } as any;

    const mockReqMatching = {
      headers: { 'if-none-match': '"hash-abc-789"' },
    } as any;

    const check1 = handler.evaluateReplayConditional(mockReqMatching, record);
    expect(check1.shouldSend304).toBe(true);

    // Weak ETag match (W/"...")
    const mockReqWeak = {
      headers: { 'if-none-match': 'W/"hash-abc-789"' },
    } as any;
    const check2 = handler.evaluateReplayConditional(mockReqWeak, record);
    expect(check2.shouldSend304).toBe(true);

    // Mismatched ETag
    const mockReqMismatch = {
      headers: { 'if-none-match': '"different-tag"' },
    } as any;
    const check3 = handler.evaluateReplayConditional(mockReqMismatch, record);
    expect(check3.shouldSend304).toBe(false);
  });
});

describe('ETag & 304 Integration with Transparent Reverse Proxy', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let proxyApp: FastifyInstance;
  let storage: MemoryStorageAdapter;
  let upstreamHits: number;

  beforeEach(async () => {
    upstreamHits = 0;
    upstreamServer = http.createServer((req, res) => {
      upstreamHits++;
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch === '"v1-canonical-tag"') {
        res.setHeader('ETag', '"v1-canonical-tag"');
        res.writeHead(304);
        res.end();
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('ETag', '"v1-canonical-tag"');
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'created', id: 'ord_123' }));
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

  it('preserves valid 200 payload across ETag validation requests and responds with 304 on cache hit', async () => {
    proxyApp = fastify({ logger: false });
    await proxyApp.register(transparentReverseProxy, {
      upstream: { targetUrl: `http://127.0.0.1:${upstreamPort}` },
      storage,
    });
    await proxyApp.ready();

    const mutationKey = 'idem-etag-order-444';

    // 1. Initial POST: 200 OK returned with ETag
    const res1 = await proxyApp.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: mutationKey,
        'content-type': 'application/json',
      },
      payload: { item: 'keyboard' },
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.headers['etag']).toBe('"v1-canonical-tag"');
    expect(JSON.parse(res1.body).id).toBe('ord_123');

    // 2. Client repeats request with If-None-Match matching cached ETag
    const res2 = await proxyApp.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: mutationKey,
        'if-none-match': '"v1-canonical-tag"',
        'content-type': 'application/json',
      },
      payload: { item: 'keyboard' },
    });

    expect(res2.statusCode).toBe(304);
    expect(res2.body).toBe('');
    expect(upstreamHits).toBe(1); // Zero extra upstream hit! Replayed from cache as 304

    // 3. Client repeats request WITHOUT If-None-Match: full cached body returned
    const res3 = await proxyApp.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: mutationKey,
        'content-type': 'application/json',
      },
      payload: { item: 'keyboard' },
    });

    expect(res3.statusCode).toBe(200);
    expect(JSON.parse(res3.body).id).toBe('ord_123'); // Cached body was NOT erased by 304!
  });
});
