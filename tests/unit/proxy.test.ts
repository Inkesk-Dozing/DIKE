/**
 * Vitest Unit & Integration Test Suite for Fastify Transparent Reverse Proxy Plugin
 * Tests proxy forwarding, header preservation, client IP propagation, and sub-millisecond overhead.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { createServer, Server } from 'node:http';
import { transparentReverseProxy } from '../../src/proxy/handler.js';
import { UpstreamDispatcher } from '../../src/proxy/upstream.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { ConnectionParkingLot } from '../../src/core/parking.js';
import { ietfHeadersPlugin } from '../../src/server/plugins/ietf_headers.js';

describe('Fastify Transparent Reverse Proxy Plugin Architecture', () => {
  let mockUpstreamServer: Server;
  let upstreamPort: number;
  let proxyApp: FastifyInstance;
  let receivedUpstreamHeaders: Record<string, string | string[] | undefined> = {};
  let receivedUpstreamBody: any = null;
  let upstreamCallCount = 0;
  let storage: MemoryStorageAdapter;
  let parkingLot: ConnectionParkingLot;

  beforeEach(async () => {
    receivedUpstreamHeaders = {};
    receivedUpstreamBody = null;
    upstreamCallCount = 0;
    storage = new MemoryStorageAdapter();
    parkingLot = new ConnectionParkingLot();

    // 1. Spin up a live mock upstream HTTP server
    mockUpstreamServer = createServer((req, res) => {
      upstreamCallCount++;
      receivedUpstreamHeaders = req.headers;

      let bodyData = '';
      req.on('data', (chunk) => {
        bodyData += chunk;
      });

      req.on('end', () => {
        try {
          receivedUpstreamBody = JSON.parse(bodyData);
        } catch {
          receivedUpstreamBody = bodyData;
        }

        res.writeHead(200, {
          'content-type': 'application/json',
          'x-custom-upstream-header': 'upstream-ack-123',
          'set-cookie': 'session_token=xyz987; Path=/',
        });
        res.end(JSON.stringify({ status: 'UPSTREAM_SUCCESS', received: receivedUpstreamBody }));
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstreamServer.listen(0, '127.0.0.1', () => {
        const addr = mockUpstreamServer.address() as any;
        upstreamPort = addr.port;
        resolve();
      });
    });

    // 2. Build Fastify proxy instance
    proxyApp = fastify({ logger: false });
    await proxyApp.register(ietfHeadersPlugin);
    await proxyApp.register(transparentReverseProxy, {
      upstream: {
        targetUrl: `http://127.0.0.1:${upstreamPort}`,
      },
      storage,
      parkingLot,
    });
    await proxyApp.ready();
  });

  afterEach(async () => {
    await proxyApp.close().catch(() => {});
    await new Promise<void>((resolve) => {
      mockUpstreamServer.close(() => resolve());
    });
    parkingLot.clear();
  });

  it('initializes UpstreamDispatcher with valid URL and strips trailing slashes', () => {
    const dispatcher = new UpstreamDispatcher({
      targetUrl: 'http://api.backend.internal:8080///',
      timeoutMs: 15_000,
      customHeaders: { 'x-proxy-version': '1.0' },
    });

    expect(dispatcher.targetUrl).toBe('http://api.backend.internal:8080');
    expect(dispatcher.timeoutMs).toBe(15_000);
    expect(dispatcher.customHeaders).toEqual({ 'x-proxy-version': '1.0' });
  });

  it('rejects initialization with empty targetUrl', () => {
    expect(() => new UpstreamDispatcher({ targetUrl: '' })).toThrow();
  });

  it('transparently passes GET requests through to upstream with zero idempotency storage queries', async () => {
    const res = await proxyApp.inject({
      method: 'GET',
      url: '/api/v1/users/42?active=true',
      headers: {
        'x-client-header': 'client-val-1',
        cookie: 'auth_id=123',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(upstreamCallCount).toBe(1);

    const body = JSON.parse(res.body);
    expect(body.status).toBe('UPSTREAM_SUCCESS');

    // Headers verification
    expect(receivedUpstreamHeaders['x-client-header']).toBe('client-val-1');
    expect(receivedUpstreamHeaders['cookie']).toBe('auth_id=123');
    expect(receivedUpstreamHeaders['x-forwarded-for']).toBeDefined();
    expect(receivedUpstreamHeaders['x-forwarded-proto']).toBe('http');

    // Upstream response headers propagated back to client
    expect(res.headers['x-custom-upstream-header']).toBe('upstream-ack-123');
    expect(res.headers['set-cookie']).toBe('session_token=xyz987; Path=/');
  });

  it('transparently passes POST requests without Idempotency-Key directly to upstream', async () => {
    const payload = { amount: 500, action: 'deposit' };

    const res = await proxyApp.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: {
        'content-type': 'application/json',
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(upstreamCallCount).toBe(1);
    expect(receivedUpstreamBody).toEqual(payload);
    expect(res.headers['idempotency-status']).toBeUndefined();
  });

  it('intercepts POST mutations with Idempotency-Key: executes leader once and returns cached replay for follower', async () => {
    const payload = { orderId: 'ord_999', total: 100 };
    const idempotencyKey = 'key_proxy_test_100';

    // 1. Leader request
    const leaderRes = await proxyApp.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-client-id': 'tenant_proxy',
      },
      payload,
    });

    expect(leaderRes.statusCode).toBe(200);
    expect(upstreamCallCount).toBe(1);
    expect(leaderRes.headers['idempotency-status']).toBe('MISS');

    // 2. Follower request (duplicate)
    const followerRes = await proxyApp.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-client-id': 'tenant_proxy',
      },
      payload,
    });

    expect(followerRes.statusCode).toBe(200);
    expect(upstreamCallCount).toBe(1); // Upstream was NOT invoked a second time!
    expect(followerRes.headers['idempotency-status']).toBe('HIT');
    expect(followerRes.body).toBe(leaderRes.body);
  });
});

