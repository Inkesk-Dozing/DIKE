/**
 * Direct Idempotency Management REST API Routes
 * Exposes programmatic endpoints (/v1/idempotency/begin, /resolve, /abort) for microservice orchestration.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Type, Static } from '@sinclair/typebox';
import { computeStaticFingerprint } from '../../core/hasher.js';
import { IIdempotencyStorage } from '../../storage/interface.js';
import { ServerConfig } from '../config.js';

export const BeginBodySchema = Type.Object({
  clientKey: Type.String({ minLength: 1, maxLength: 255 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 255 }),
  method: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  payload: Type.Optional(Type.Unknown()),
  fingerprint: Type.Optional(Type.String({ minLength: 16, maxLength: 128 })),
  ttlMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 86400000 })),
  lockTimeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 300000 })),
});
export type BeginBody = Static<typeof BeginBodySchema>;

export const ResolveBodySchema = Type.Object({
  clientKey: Type.String({ minLength: 1, maxLength: 255 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 255 }),
  statusCode: Type.Integer({ minimum: 100, maximum: 599 }),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  body: Type.Optional(Type.Unknown()),
  fencingToken: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
});
export type ResolveBody = Static<typeof ResolveBodySchema>;

export const AbortBodySchema = Type.Object({
  clientKey: Type.String({ minLength: 1, maxLength: 255 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 255 }),
  reason: Type.String({ minLength: 1, maxLength: 1024 }),
  fencingToken: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
});
export type AbortBody = Static<typeof AbortBodySchema>;

export const idempotencyRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  const storage = (app as unknown as { storage: IIdempotencyStorage }).storage;
  const config = (app as unknown as { config: ServerConfig }).config;

  /**
   * POST /v1/idempotency/begin
   * Attempts to acquire an idempotency lock or returns the cached response.
   */
  app.post<{ Body: BeginBody }>(
    '/v1/idempotency/begin',
    {
      schema: {
        body: BeginBodySchema,
      },
    },
    async (req: FastifyRequest<{ Body: BeginBody }>, reply: FastifyReply) => {
      const { clientKey, idempotencyKey, method = 'POST', path = '/', payload, fingerprint, ttlMs, lockTimeoutMs } = req.body;

      const effectiveFingerprint =
        fingerprint ?? computeStaticFingerprint(method, path, payload ?? {});
      const effectiveTtlMs = ttlMs ?? config.IDEMPOTENCY_DEFAULT_TTL_MS;
      const effectiveLockTimeoutMs = lockTimeoutMs ?? config.IDEMPOTENCY_LOCK_TIMEOUT_MS;

      const acquireResult = await storage.acquire({
        tenantId: clientKey,
        key: idempotencyKey,
        requestFingerprint: effectiveFingerprint,
        ttlMs: effectiveTtlMs,
        lockTimeoutMs: effectiveLockTimeoutMs,
      });

      switch (acquireResult.status) {
        case 'ACQUIRED':
          return reply.status(200).send({
            status: 'ACQUIRED',
            fencingToken: acquireResult.fencingToken?.toString(),
            message: 'Idempotency lock successfully granted.',
          });

        case 'CACHED':
          return reply.status(200).send({
            status: 'CACHED',
            response: {
              statusCode: acquireResult.record?.responseStatus ?? 200,
              headers: acquireResult.record?.responseHeaders ?? {},
              body: acquireResult.record?.responseBody ?? null,
            },
            cachedAt: acquireResult.record?.updatedAt?.toISOString(),
          });

        case 'IN_PROGRESS':
          return reply.status(409).send({
            error: 'ConflictError',
            status: 'IN_PROGRESS',
            message: `Mutation for idempotency key "${idempotencyKey}" is currently being processed by another worker.`,
          });

        case 'PAYLOAD_MISMATCH':
          return reply.status(422).send({
            error: 'PayloadMismatchError',
            status: 'MISMATCH',
            message: `Payload mismatch detected for idempotency key "${idempotencyKey}".`,
            expectedFingerprint: acquireResult.record?.requestFingerprint,
            receivedFingerprint: effectiveFingerprint,
          });

        default:
          return reply.status(500).send({
            error: 'InternalError',
            message: 'Unknown acquire status received.',
          });
      }
    }
  );

  /**
   * POST /v1/idempotency/resolve
   * Commits the resolved status, headers, and response payload.
   */
  app.post<{ Body: ResolveBody }>(
    '/v1/idempotency/resolve',
    {
      schema: {
        body: ResolveBodySchema,
      },
    },
    async (req: FastifyRequest<{ Body: ResolveBody }>, reply: FastifyReply) => {
      const { clientKey, idempotencyKey, statusCode, headers, body, fencingToken } = req.body;

      const parsedFencingToken =
        fencingToken !== undefined ? BigInt(fencingToken) : undefined;

      await storage.resolve({
        tenantId: clientKey,
        key: idempotencyKey,
        responseStatus: statusCode,
        responseHeaders: headers,
        responseBody: body,
        fencingToken: parsedFencingToken,
      });

      return reply.status(200).send({
        status: 'RESOLVED',
        idempotencyKey,
        message: 'Idempotency key successfully resolved and cached.',
      });
    }
  );

  /**
   * POST /v1/idempotency/abort
   * Aborts the in-flight idempotency lease due to downstream execution failure.
   */
  app.post<{ Body: AbortBody }>(
    '/v1/idempotency/abort',
    {
      schema: {
        body: AbortBodySchema,
      },
    },
    async (req: FastifyRequest<{ Body: AbortBody }>, reply: FastifyReply) => {
      const { clientKey, idempotencyKey, reason, fencingToken } = req.body;

      const parsedFencingToken =
        fencingToken !== undefined ? BigInt(fencingToken) : undefined;

      await storage.abort({
        tenantId: clientKey,
        key: idempotencyKey,
        errorReason: reason,
        fencingToken: parsedFencingToken,
      });

      return reply.status(200).send({
        status: 'ABORTED',
        idempotencyKey,
        message: `Idempotency execution aborted: ${reason}`,
      });
    }
  );
};
