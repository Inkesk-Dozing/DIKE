/**
 * Fastify Server Pipeline & Application Factory
 * Configures HTTP routing, security middleware, Prometheus metrics endpoint, probes, and structured error boundaries.
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
import { attestVerifyRoutes } from './routes/attest.js';
import { socketDrain, DrainManager } from './drain.js';
import { AttestationReceiptSigner } from '../security/attest.js';
import { PrometheusRegistry, defaultMetricsRegistry } from '../telemetry/metrics.js';
import { DistributedTracer, defaultDistributedTracer, W3C_TRACEPARENT_HEADER } from '../telemetry/tracing.js';
import { DEFAULT_REDACT_PATHS, generateTraceId, REDACTED_MASK } from '../utils/logger.js';

export interface AppOptions {
  readonly config?: Partial<ServerConfig> | undefined;
  readonly storage?: IIdempotencyStorage | undefined;
  readonly drainManager?: DrainManager | undefined;
  readonly attestationSigner?: AttestationReceiptSigner | undefined;
  readonly metricsRegistry?: PrometheusRegistry | undefined;
  readonly tracer?: DistributedTracer | undefined;
}

export interface StorageHealthCapable {
  healthCheck?(): Promise<boolean>;
}

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
    traceContext?: ReturnType<DistributedTracer['extractContext']>;
  }
  interface FastifyInstance {
    drainManager: DrainManager;
    attestationSigner?: AttestationReceiptSigner | undefined;
    metricsRegistry: PrometheusRegistry;
    tracer: DistributedTracer;
  }
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...(options.config ?? {}) };
  const storage = options.storage ?? new MemoryStorageAdapter();
  const drainManager = options.drainManager ?? new DrainManager();
  const metricsRegistry = options.metricsRegistry ?? defaultMetricsRegistry;
  const tracer = options.tracer ?? defaultDistributedTracer;

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
    disableRequestLogging: config.LOG_LEVEL === 'silent',
    connectionTimeout: 10_000,
    keepAliveTimeout: 5_000,
  });

  // Attach Trace ID & W3C Traceparent Correlation Hook
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawTraceIdHeader = req.headers['x-trace-id'];
    const customTraceId = Array.isArray(rawTraceIdHeader) ? rawTraceIdHeader[0] : rawTraceIdHeader;

    const traceCtx = tracer.extractContext(req);
    req.traceContext = traceCtx;

    // If client supplied explicit x-trace-id, prioritize it.
    // Otherwise, if client provided W3C traceparent, synchronize x-trace-id to traceparent traceId.
    // If neither was provided, default to RFC 4122 v4 UUID.
    const hasExplicitTraceparent = Boolean(req.headers[W3C_TRACEPARENT_HEADER]);
    const activeTraceId = customTraceId || (hasExplicitTraceparent ? traceCtx.traceId : generateTraceId());
    req.traceId = activeTraceId;

    reply.header('x-trace-id', activeTraceId);
    reply.header(W3C_TRACEPARENT_HEADER, `${traceCtx.version}-${traceCtx.traceId}-${traceCtx.spanId}-${traceCtx.traceFlags}`);
  });

  // Prometheus Metrics onResponse Hook
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const idempotencyStatus = (reply.getHeader('idempotency-status') as string) || 'NONE';
    metricsRegistry.requestsTotal.inc({
      method: req.method,
      status: reply.statusCode,
      idempotency: idempotencyStatus,
    });

    const tenant = (req.headers['x-client-id'] as string) || (req.headers['x-tenant-id'] as string) || 'default_tenant';
    if (idempotencyStatus === 'HIT') {
      metricsRegistry.cacheHitsTotal.inc({ tenant });
    } else if (idempotencyStatus === 'MISS') {
      metricsRegistry.cacheMissesTotal.inc({ tenant });
    }
  });

  // Core Security Plugins
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Client-Id', 'X-Tenant-Id', 'X-Trace-Id', 'traceparent', 'tracestate'],
    exposedHeaders: ['Idempotency-Key', 'Idempotency-Status', 'X-Trace-Id', 'traceparent', 'X-DIKE-Attestation'],
  });

  // Zero-Downtime Socket Drainage Engine
  await app.register(socketDrain, {
    drainManager,
  });

  // IETF Idempotency Header Lifecycle Hook
  await app.register(ietfHeadersPlugin);

  // Decorators
  app.decorate('config', config);
  app.decorate('storage', storage);
  app.decorate('metricsRegistry', metricsRegistry);
  app.decorate('tracer', tracer);
  if (options.attestationSigner) {
    app.decorate('attestationSigner', options.attestationSigner);
  }

  // Register Core REST Routes
  await app.register(idempotencyRoutes);
  await app.register(attestVerifyRoutes, {
    attestationSigner: options.attestationSigner,
  });

  // Prometheus Metrics Endpoint (/metrics)
  app.get('/metrics', async (_req: FastifyRequest, reply: FastifyReply) => {
    const rendered = metricsRegistry.renderMetrics();
    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .status(200)
      .send(rendered);
  });

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
    // If pod is draining, fail readiness probe to instantly cut Ingress traffic
    if (drainManager.isDraining()) {
      return reply.status(503).send({
        status: 'draining',
        message: 'Pod is terminating and draining active connections.',
        activeSockets: drainManager.getActiveSocketsCount(),
        timestamp: new Date().toISOString(),
      });
    }

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
