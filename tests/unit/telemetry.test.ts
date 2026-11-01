/**
 * Test Suite: OpenTelemetry Metrics & Distributed Trace Context Propagation (Issue #58)
 * Validates:
 * - Prometheus metrics collection (counters, gauges, histograms) and export at /metrics.
 * - Cache hit/miss telemetry tracking.
 * - Ingress W3C traceparent extraction and child span propagation to upstream headers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { PrometheusRegistry } from '../../src/telemetry/metrics.js';
import {
  DistributedTracer,
  W3C_TRACEPARENT_HEADER,
} from '../../src/telemetry/tracing.js';
import { UpstreamDispatcher } from '../../src/proxy/upstream.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { IETF_IDEMPOTENCY_KEY_HEADER } from '../../src/server/plugins/ietf_headers.js';

describe('OpenTelemetry Metrics Registry Unit Tests', () => {
  let registry: PrometheusRegistry;

  beforeEach(() => {
    registry = new PrometheusRegistry();
  });

  it('correctly increments counters and generates Prometheus text output', () => {
    registry.requestsTotal.inc({ method: 'POST', status: 200, idempotency: 'MISS' });
    registry.requestsTotal.inc({ method: 'POST', status: 200, idempotency: 'HIT' }, 2);

    registry.cacheHitsTotal.inc({ tenant: 'tenant_a' }, 2);
    registry.cacheMissesTotal.inc({ tenant: 'tenant_a' }, 1);

    const rendered = registry.renderMetrics();
    expect(rendered).toContain('dike_requests_total{idempotency="MISS",method="POST",status="200"} 1');
    expect(rendered).toContain('dike_requests_total{idempotency="HIT",method="POST",status="200"} 2');
    expect(rendered).toContain('dike_cache_hits_total{tenant="tenant_a"} 2');
    expect(rendered).toContain('dike_cache_misses_total{tenant="tenant_a"} 1');
  });

  it('correctly sets, increments, and decrements gauges', () => {
    registry.parkedConnectionsActive.set({ tenant: 'tenant_x' }, 5);
    registry.parkedConnectionsActive.inc({ tenant: 'tenant_x' }, 3);
    registry.parkedConnectionsActive.dec({ tenant: 'tenant_x' }, 2);

    expect(registry.parkedConnectionsActive.get({ tenant: 'tenant_x' })).toBe(6);
    expect(registry.renderMetrics()).toContain('dike_parked_connections_active{tenant="tenant_x"} 6');
  });

  it('observes histogram values', () => {
    registry.mutationDurationSeconds.observe(0.045);
    registry.mutationDurationSeconds.observe(0.120);

    const rendered = registry.renderMetrics();
    expect(rendered).toContain('dike_mutation_duration_seconds_count 2');
    expect(rendered).toContain('dike_mutation_duration_seconds_bucket{le="0.05"} 1');
    expect(rendered).toContain('dike_mutation_duration_seconds_bucket{le="0.25"} 2');
  });
});

describe('DistributedTracer (W3C TraceContext) Unit Tests', () => {
  const tracer = new DistributedTracer();

  it('extracts existing W3C traceparent and creates child span', () => {
    const parentTrace = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentSpan = '00f067aa0ba902b7';
    const incomingHeader = `00-${parentTrace}-${parentSpan}-01`;

    const mockReq = {
      headers: {
        [W3C_TRACEPARENT_HEADER]: incomingHeader,
        tracestate: 'congo=t61rcWkgMzE',
      },
    } as any;

    const ctx = tracer.extractContext(mockReq);
    expect(ctx.version).toBe('00');
    expect(ctx.traceId).toBe(parentTrace); // Preserves distributed trace ID
    expect(ctx.parentSpanId).toBe(parentSpan);
    expect(ctx.spanId).toHaveLength(16); // Fresh child span ID generated
    expect(ctx.spanId).not.toBe(parentSpan);
    expect(ctx.traceFlags).toBe('01');
    expect(ctx.traceState).toBe('congo=t61rcWkgMzE');

    // Injects child span into outbound headers
    const outbound = tracer.injectHeaders(ctx);
    expect(outbound[W3C_TRACEPARENT_HEADER]).toMatch(new RegExp(`^00-${parentTrace}-[0-9a-f]{16}-01$`));
    expect(outbound['x-trace-id']).toBe(parentTrace);
    expect(outbound['tracestate']).toBe('congo=t61rcWkgMzE');
  });

  it('generates a fresh 32-character trace ID if traceparent is absent or invalid', () => {
    const mockReq = { headers: {} } as any;
    const ctx = tracer.extractContext(mockReq);

    expect(ctx.traceId).toHaveLength(32);
    expect(ctx.spanId).toHaveLength(16);
    expect(ctx.parentSpanId).toBeUndefined();
  });
});

describe('Prometheus & W3C Tracing Integration with Server', () => {
  let app: FastifyInstance;
  let registry: PrometheusRegistry;

  beforeEach(async () => {
    registry = new PrometheusRegistry();
    app = await buildApp({
      storage: new MemoryStorageAdapter(),
      metricsRegistry: registry,
      config: { LOG_LEVEL: 'silent' },
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('exposes Prometheus metrics at /metrics', async () => {
    // Perform a request to generate metrics
    await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('dike_requests_total');
    expect(res.body).toContain('dike_cache_hits_total');
    expect(res.body).toContain('dike_parked_connections_active');
  });

  it('propagates W3C traceparent seamlessly through Fastify lifecycle', async () => {
    const inboundTrace = '11223344556677889900aabbccddeeff';
    const inboundSpan = '1234567890abcdef';
    const traceparent = `00-${inboundTrace}-${inboundSpan}-01`;

    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: {
        traceparent,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-trace-id']).toBe(inboundTrace);
    expect(res.headers['traceparent']).toMatch(new RegExp(`^00-${inboundTrace}-[0-9a-f]{16}-01$`));
  });

  it('forwards trace context to upstream dispatcher', () => {
    const dispatcher = new UpstreamDispatcher({ targetUrl: 'http://upstream.local:8080' });

    const reqMock = {
      method: 'POST',
      url: '/api/v1/charge',
      headers: {},
      ip: '10.0.0.1',
      socket: { remoteAddress: '10.0.0.1' },
      traceContext: {
        version: '00',
        traceId: 'aabbccddeeff00112233445566778899',
        spanId: '1234567812345678',
        traceFlags: '01',
      },
      traceId: 'aabbccddeeff00112233445566778899',
    } as any;

    const headers = dispatcher.prepareForwardHeaders(reqMock);
    expect(headers[W3C_TRACEPARENT_HEADER]).toMatch(/^00-aabbccddeeff00112233445566778899-[0-9a-f]{16}-01$/);
    expect(headers['x-trace-id']).toBe('aabbccddeeff00112233445566778899');
  });
});
