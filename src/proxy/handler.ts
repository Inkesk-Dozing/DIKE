/**
 * Fastify Transparent Reverse Proxy Plugin Architecture for DIKE
 * Attaches transparent reverse proxy forwarding with automatic header propagation,
 * selective idempotency interception, cryptographic attestation receipt signing,
 * and sub-millisecond proxy pipeline overhead.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { UpstreamDispatcher, UpstreamConfig } from './upstream.js';
import { IdempotencyInterceptor, InterceptorOptions } from './interceptor.js';
import { ResponseHeaderFilter, HeaderFilterOptions } from './header_filter.js';
import { AttestationReceiptSigner, ATTESTATION_HEADER_NAME } from '../security/attest.js';
import { IIdempotencyStorage } from '../storage/interface.js';
import { ConnectionParkingLot } from '../core/parking.js';
import { executeIdempotentMutation } from '../core/orchestrator.js';

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
   * Optional cryptographic attestation signer.
   */
  readonly attestationSigner?: AttestationReceiptSigner | undefined;
  /**
   * Route prefix for reverse proxy endpoints. Defaults to '/' (all non-management routes).
   */
  readonly prefix?: string | undefined;
  /**
   * Interceptor options (strictMode, custom mutation methods, excluded paths).
   */
  readonly interceptorOptions?: InterceptorOptions | undefined;
  /**
   * Header filtering options (hop-by-hop stripping, fresh date injection).
   */
  readonly headerFilterOptions?: HeaderFilterOptions | undefined;
  /**
   * Paths excluded from reverse proxying (e.g. /healthz, /readyz, /v1/idempotency).
   */
  readonly excludedPaths?: string[] | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    upstreamDispatcher: UpstreamDispatcher;
    idempotencyInterceptor: IdempotencyInterceptor;
    responseHeaderFilter: ResponseHeaderFilter;
    attestationSigner?: AttestationReceiptSigner | undefined;
  }
}

export const transparentReverseProxyPlugin: FastifyPluginAsync<ReverseProxyPluginOptions> = async (
  app: FastifyInstance,
  opts
): Promise<void> => {
  const dispatcher = new UpstreamDispatcher(opts.upstream);
  app.decorate('upstreamDispatcher', dispatcher);

  const interceptor = new IdempotencyInterceptor({
    ...opts.interceptorOptions,
    excludedPaths: [
      ...(opts.excludedPaths ?? []),
      ...(opts.interceptorOptions?.excludedPaths ?? []),
    ],
  });
  app.decorate('idempotencyInterceptor', interceptor);

  const headerFilter = new ResponseHeaderFilter(opts.headerFilterOptions);
  app.decorate('responseHeaderFilter', headerFilter);

  const attestationSigner = opts.attestationSigner ?? (app as any).attestationSigner;
  if (attestationSigner) {
    app.decorate('attestationSigner', attestationSigner);
  }

  const storage = opts.storage ?? (app as any).storage;
  const parkingLot = opts.parkingLot ?? (app as any).parkingLot ?? new ConnectionParkingLot();

  /**
   * Universal catch-all reverse proxy route handler
   */
  app.all('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const decision = interceptor.evaluate(req, Boolean(storage));

    // 1. Rejection (e.g. Strict Mode violation)
    if (decision.action === 'REJECT') {
      return reply.status(decision.statusCode).send({
        error: 'Bad Request',
        message: decision.message,
      });
    }

    // 2. Direct Pass-through: Non-mutation, missing key without strict mode, or excluded paths
    if (decision.action === 'BYPASS') {
      // If it's an internal excluded path, do not forward to upstream
      if (decision.reason === 'EXCLUDED_PATH') {
        return;
      }

      const upstreamRes = await dispatcher.forward(req);
      const sanitizedHeaders = headerFilter.sanitizeForStorage(upstreamRes.headers);

      // Replay headers onto FastifyReply
      for (const [k, v] of Object.entries(sanitizedHeaders)) {
        if (k === 'content-length' || k === 'transfer-encoding') continue;
        reply.header(k, v);
      }

      return reply.status(upstreamRes.statusCode).send(upstreamRes.body);
    }

    // 3. Idempotent Interception: Mutation with valid Idempotency-Key
    const { key: idempotencyKey, tenantId } = decision;

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

        const sanitizedHeaders = headerFilter.sanitizeForStorage(upstreamRes.headers);

        return {
          statusCode: upstreamRes.statusCode,
          headers: sanitizedHeaders,
          body: parsedBody,
        };
      },
    });

    if (reply.setIdempotencyStatus) {
      reply.setIdempotencyStatus(executionResult.idempotencyStatus);
    }

    if (executionResult.headers) {
      const isReplay = executionResult.idempotencyStatus === 'HIT';
      const outHeaders = isReplay
        ? headerFilter.prepareReplayHeaders(executionResult.headers)
        : executionResult.headers;

      for (const [k, v] of Object.entries(outHeaders)) {
        if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'transfer-encoding') continue;
        reply.header(k, v);
      }
    }

    // If attestation signer is configured and this is a replayed cache hit, attach cryptographic receipt
    if (attestationSigner && executionResult.idempotencyStatus === 'HIT') {
      const receipt = attestationSigner.sign({
        tenantId,
        key: idempotencyKey,
        fingerprint: (executionResult as any).fingerprint ?? '',
        statusCode: executionResult.statusCode,
      });
      reply.header(ATTESTATION_HEADER_NAME, receipt.headerValue);
    }

    return reply.status(executionResult.statusCode).send(executionResult.body);
  });
};

export const transparentReverseProxy = fp(transparentReverseProxyPlugin, {
  name: 'transparent-reverse-proxy',
  fastify: '5.x',
});
