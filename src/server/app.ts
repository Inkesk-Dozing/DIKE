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

export interface AppOptions {
  readonly config?: Partial<ServerConfig> | undefined;
  readonly storage?: IIdempotencyStorage | undefined;
}

export interface StorageHealthCapable {
  healthCheck?(): Promise<boolean>;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...(options.config ?? {}) };
  const storage = options.storage ?? new MemoryStorageAdapter();

  const app: FastifyInstance = fastify({
    logger: config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL },
  });

  // Security Headers and Cross-Origin Resource Sharing
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Global Context Decorators
  app.decorate('config', config);
  app.decorate('storage', storage);

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
