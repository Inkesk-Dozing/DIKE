/**
 * Fastify Server Pipeline & Application Factory
 * Configures HTTP routing, security middleware, probes, and structured error boundaries.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { loadConfig, ServerConfig } from './config.js';
import { IIdempotencyStorage } from '../storage/interface.js';
import { MemoryStorageAdapter } from '../storage/memory.js';
import { ietfHeadersPlugin } from './plugins/ietf_headers.js';
import { idempotencyRoutes } from './routes/idempotency.js';
import { DEFAULT_REDACT_PATHS, generateTraceId, REDACTED_MASK } from '../utils/logger.js';

export interface AppOptions {
  readonly config?: Partial<ServerConfig> | undefined;
  readonly storage?: IIdempotencyStorage | undefined;
}

export interface StorageHealthCapable {
  healthCheck?(): Promise<boolean>;
}

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
  }
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...(options.config ?? {}) };
  const storage = options.storage ?? new MemoryStorageAdapter();

  const app: FastifyInstance = fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: {
              paths: DEFAULT_REDACT_PATHS,
              censor: REDACTED_MASK,
            },
          },
    genReqId: (req) => (req.headers['x-trace-id'] as string) || generateTraceId(),
    requestIdHeader: 'x-trace-id',
  });

  // Security Headers and Cross-Origin Resource Sharing
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Trace ID Decorator and Response Header Hook
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    req.traceId = req.id;
    reply.header('x-trace-id', req.id);
  });

  // IETF Idempotency-Key Standard HTTP Header Compliance Plugin
  await app.register(ietfHeadersPlugin);

  // Global Context Decorators
  app.decorate('config', config);
  app.decorate('storage', storage);

  // Register Core REST Routes
  await app.register(idempotencyRoutes);

  // Standardized Error Handler
  app.setErrorHandler((error: Error & { statusCode?: number }, _req: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode ?? 500;
    app.log.error(error);

    reply.status(statusCode).send({
      error: error.name || 'InternalServerError',
      message: error.message || 'An unexpected internal error occurred.',
      statusCode,
      timestamp: new Date().toISOString(),
    });
  });

  // Standardized 404 Not Found Handler
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send({
      error: 'NotFoundError',
      message: `Route ${req.method} ${req.url} not found.`,
      statusCode: 404,
      timestamp: new Date().toISOString(),
    });
  });

  // Kubernetes Probes: Liveness (/healthz)
  app.get('/healthz', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Kubernetes Probes: Readiness (/readyz)
  app.get('/readyz', async (_req: FastifyRequest, reply: FastifyReply) => {
    let isHealthy = true;
    const healthStorage = storage as StorageHealthCapable;

    if (typeof healthStorage.healthCheck === 'function') {
      try {
        isHealthy = await healthStorage.healthCheck();
      } catch {
        isHealthy = false;
      }
    }

    if (!isHealthy) {
      return reply.status(503).send({
        status: 'unhealthy',
        checks: {
          storage: 'down',
        },
        timestamp: new Date().toISOString(),
      });
    }

    return reply.status(200).send({
      status: 'ready',
      checks: {
        storage: 'up',
      },
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
