/**
 * Fastify Transparent Reverse Proxy Plugin Architecture for DIKE
 * Attaches transparent reverse proxy forwarding with automatic header propagation,
 * selective idempotency interception, and sub-millisecond proxy pipeline overhead.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { UpstreamDispatcher, UpstreamConfig } from './upstream.js';
import { IIdempotencyStorage } from '../storage/interface.js';
import { ConnectionParkingLot } from '../core/parking.js';
import { executeIdempotentMutation } from '../core/orchestrator.js';
import { IETF_IDEMPOTENCY_KEY_HEADER } from '../server/plugins/ietf_headers.js';

export interface ReverseProxyPluginOptions {
  /**
   * Target upstream configuration.
   */
  readonly upstream: UpstreamConfig;
  /**
   * Reference to storage tier adapter.
   */
  readonly storage?: IIdempotencyStorage | undefined;
  /**
   * Reference to ConnectionParkingLot multiplexer.
   */
  readonly parkingLot?: ConnectionParkingLot | undefined;
  /**
   * Route prefix for reverse proxy endpoints. Defaults to '/' (all non-management routes).
   */
  readonly prefix?: string | undefined;
  /**
   * Paths excluded from reverse proxying (e.g. /healthz, /readyz, /v1/idempotency).
   */
  readonly excludedPaths?: string[] | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    upstreamDispatcher: UpstreamDispatcher;
  }
}

export const transparentReverseProxyPlugin: FastifyPluginAsync<ReverseProxyPluginOptions> = async (
  app: FastifyInstance,
  opts
): Promise<void> => {
  const dispatcher = new UpstreamDispatcher(opts.upstream);
  app.decorate('upstreamDispatcher', dispatcher);

  const storage = opts.storage ?? (app as any).storage;
  const parkingLot = opts.parkingLot ?? (app as any).parkingLot ?? new ConnectionParkingLot();

  const excludedPaths = new Set([
    '/healthz',
    '/readyz',
    '/drain',
    '/v1/idempotency/begin',
    '/v1/idempotency/resolve',
    '/v1/idempotency/abort',
    ...(opts.excludedPaths ?? []),
  ]);

  /**
   * Universal catch-all reverse proxy route handler
   */
  app.all('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    // If request matches an internal management endpoint, skip proxying
    const pathname = (req.url || '/').split('?')[0] ?? '/';
    if (excludedPaths.has(pathname)) {
      return;
    }

    const rawKey = req.headers[IETF_IDEMPOTENCY_KEY_HEADER];
    const isMutation = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';

    // 1. Transparent Pass-through: Non-mutation OR mutation without Idempotency-Key
    if (!isMutation || !rawKey || !storage) {
      const upstreamRes = await dispatcher.forward(req);

      // Replay headers onto FastifyReply
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (k === 'content-length' || k === 'transfer-encoding') continue;
        reply.header(k, v);
      }

      return reply.status(upstreamRes.statusCode).send(upstreamRes.body);
    }

    // 2. Idempotent Interception: Mutation with Idempotency-Key header present
    const idempotencyKey = Array.isArray(rawKey) ? (rawKey[0] ?? '').trim() : String(rawKey).trim();
    const tenantId = (req.headers['x-client-id'] as string) || (req.headers['x-tenant-id'] as string) || 'default_tenant';

    const executionResult = await executeIdempotentMutation({
      tenantId,
      key: idempotencyKey,
      storage,
      parkingLot,
      method: req.method,
      path: req.url,
      requestPayload: req.body as any,
      action: async () => {
        const upstreamRes = await dispatcher.forward(req);
        let parsedBody: any;
        try {
          parsedBody = JSON.parse(upstreamRes.body.toString('utf-8'));
        } catch {
          parsedBody = upstreamRes.body.toString('utf-8');
        }

        return {
          statusCode: upstreamRes.statusCode,
          headers: upstreamRes.headers,
          body: parsedBody,
        };
      },
    });

    if (reply.setIdempotencyStatus) {
      reply.setIdempotencyStatus(executionResult.idempotencyStatus);
    }

    if (executionResult.headers) {
      for (const [k, v] of Object.entries(executionResult.headers)) {
        if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'transfer-encoding') continue;
        reply.header(k, v);
      }
    }

    return reply.status(executionResult.statusCode).send(executionResult.body);
  });
};

export const transparentReverseProxy = fp(transparentReverseProxyPlugin, {
  name: 'transparent-reverse-proxy',
  fastify: '5.x',
});
