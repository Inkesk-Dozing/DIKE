/**
 * Test Suite: Response Header Whitelist & Hop-by-Hop Filter Engine (Issue #52)
 * Verifies RFC 7230 hop-by-hop header removal, connection-token stripping,
 * business header preservation, fresh Date injection, and replay timestamping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fastify, { FastifyInstance } from 'fastify';
import { ResponseHeaderFilter, RFC7230_HOP_BY_HOP_HEADERS } from '../../src/proxy/header_filter.js';
import { transparentReverseProxy } from '../../src/proxy/handler.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { IETF_IDEMPOTENCY_KEY_HEADER } from '../../src/server/plugins/ietf_headers.js';

describe('ResponseHeaderFilter Unit Tests', () => {
  it('strips all standard RFC 7230 hop-by-hop headers', () => {
    const filter = new ResponseHeaderFilter();

    const rawHeaders: Record<string, string> = {
      connection: 'keep-alive',
      'keep-alive': 'timeout=5, max=1000',
      'proxy-authenticate': 'Basic realm="Access to proxy"',
      'proxy-authorization': 'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      te: 'trailers, deflate',
      trailer: 'X-Checksum',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      'content-type': 'application/json',
      'x-custom-tenant': 'tenant_123',
    };

    const sanitized = filter.sanitizeForStorage(rawHeaders);

    for (const hopHeader of RFC7230_HOP_BY_HOP_HEADERS) {
      expect(sanitized).not.toHaveProperty(hopHeader);
    }

    expect(sanitized['content-type']).toBe('application/json');
    expect(sanitized['x-custom-tenant']).toBe('tenant_123');
  });

  it('strips headers nominated by the Connection header value (RFC 7230 Section 6.1)', () => {
    const filter = new ResponseHeaderFilter();

    const rawHeaders: Record<string, string> = {
      connection: 'X-Ephemeral-Session, X-Socket-ID',
      'x-ephemeral-session': 'sess_abc123',
      'x-socket-id': 'sock_999',
      'content-type': 'application/json',
      'x-business-id': 'bus_456',
    };

    const sanitized = filter.sanitizeForStorage(rawHeaders);

    expect(sanitized).not.toHaveProperty('connection');
    expect(sanitized).not.toHaveProperty('x-ephemeral-session');
    expect(sanitized).not.toHaveProperty('x-socket-id');
    expect(sanitized['content-type']).toBe('application/json');
    expect(sanitized['x-business-id']).toBe('bus_456');
  });

  it('preserves headers when explicitly included in preservedHeaders override', () => {
    const filter = new ResponseHeaderFilter({
      preservedHeaders: ['keep-alive'],
    });

    const rawHeaders: Record<string, string> = {
      connection: 'close',
      'keep-alive': 'timeout=10',
      'content-type': 'application/json',
    };

    const sanitized = filter.sanitizeForStorage(rawHeaders);

    expect(sanitized).not.toHaveProperty('connection');
    expect(sanitized['keep-alive']).toBe('timeout=10');
    expect(sanitized['content-type']).toBe('application/json');
  });

  it('prepares replay headers with fresh Date and idempotency-replayed-at timestamp', () => {
    const filter = new ResponseHeaderFilter({
      injectFreshDate: true,
      injectReplayedAt: true,
    });

    const storedHeaders: Record<string, string> = {
      'content-type': 'application/json',
      date: 'Wed, 21 Oct 2015 07:28:00 GMT',
      'x-request-id': 'req_xyz789',
    };

    const replayTime = new Date('2026-11-01T12:00:00Z');
    const replayHeaders = filter.prepareReplayHeaders(storedHeaders, replayTime);

    expect(replayHeaders['content-type']).toBe('application/json');
    expect(replayHeaders['x-request-id']).toBe('req_xyz789');
    expect(replayHeaders['date']).toBe(replayTime.toUTCString());
    expect(replayHeaders['idempotency-replayed-at']).toBe('2026-11-01T12:00:00.000Z');
  });
});

describe('ResponseHeaderFilter Integration with Reverse Proxy Pipeline', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let proxyApp: FastifyInstance;
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    upstreamServer = http.createServer((req, res) => {
      // Upstream sets both hop-by-hop and application business headers
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Keep-Alive', 'timeout=5');
      res.setHeader('X-Upstream-Transaction', 'tx_98765');
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', path: req.url }));
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

  it('sanitizes hop-by-hop headers and adds replayed-at header on idempotent replay (HIT)', async () => {
    proxyApp = fastify({ logger: false });
    await proxyApp.register(transparentReverseProxy, {
      upstream: { targetUrl: `http://127.0.0.1:${upstreamPort}` },
      storage,
    });
    await proxyApp.ready();

    const mutationKey = 'idem-header-test-123';

    // First request: MISS
    const res1 = await proxyApp.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: mutationKey,
        'content-type': 'application/json',
      },
      payload: { item: 'book' },
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-upstream-transaction']).toBe('tx_98765');
    expect(res1.headers['keep-alive']).toBeUndefined();
    expect(res1.headers['idempotency-replayed-at']).toBeUndefined(); // Fresh execution

    // Second request: HIT (Replay)
    const res2 = await proxyApp.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: mutationKey,
        'content-type': 'application/json',
      },
      payload: { item: 'book' },
    });

    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-upstream-transaction']).toBe('tx_98765'); // Preserved business header
    expect(res2.headers['keep-alive']).toBeUndefined(); // Hop-by-hop dropped
    expect(res2.headers['idempotency-replayed-at']).toBeDefined(); // Fresh replay timestamp injected
  });
});
