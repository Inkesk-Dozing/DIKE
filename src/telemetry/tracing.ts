/**
 * OpenTelemetry Distributed Trace Context Propagation (W3C TraceContext)
 * Parses incoming W3C `traceparent` headers, extracts TraceId & SpanId,
 * creates child spans, and injects outbound headers into upstream requests.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import crypto from 'crypto';
import { FastifyRequest } from 'fastify';

export const W3C_TRACEPARENT_HEADER = 'traceparent';
export const W3C_TRACESTATE_HEADER = 'tracestate';

export interface TraceContext {
  readonly version: string;
  readonly traceId: string;
  readonly parentSpanId?: string | undefined;
  readonly spanId: string;
  readonly traceFlags: string;
  readonly traceState?: string | undefined;
}

export class DistributedTracer {
  /**
   * Generates a 32-character hexadecimal trace ID (16 bytes).
   */
  public generateTraceId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Generates a 16-character hexadecimal span ID (8 bytes).
   */
  public generateSpanId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Parses W3C traceparent header:
   * Format: version-traceId-parentId-traceFlags (e.g. 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01)
   */
  public extractContext(req: FastifyRequest): TraceContext {
    const raw = req.headers[W3C_TRACEPARENT_HEADER];
    const traceState = req.headers[W3C_TRACESTATE_HEADER] as string | undefined;

    if (typeof raw === 'string') {
      const parts = raw.trim().split('-');
      if (parts.length === 4 && parts[0] === '00') {
        const traceId = parts[1]!;
        const parentSpanId = parts[2]!;
        const traceFlags = parts[3]!;

        if (traceId.length === 32 && parentSpanId.length === 16) {
          return {
            version: '00',
            traceId,
            parentSpanId,
            spanId: this.generateSpanId(), // create child span for DIKE proxy
            traceFlags,
            traceState,
          };
        }
      }
    }

    // If traceparent header absent or invalid, generate fresh root trace
    const legacyTraceId = req.traceId || (req.headers['x-trace-id'] as string);
    const traceId =
      legacyTraceId && legacyTraceId.length === 32 && /^[0-9a-f]+$/i.test(legacyTraceId)
        ? legacyTraceId.toLowerCase()
        : this.generateTraceId();

    return {
      version: '00',
      traceId,
      spanId: this.generateSpanId(),
      traceFlags: '01',
      traceState,
    };
  }

  /**
   * Injects trace context into outbound HTTP request headers.
   */
  public injectHeaders(
    context: TraceContext,
    targetHeaders: Record<string, string> = {}
  ): Record<string, string> {
    const childSpanId = this.generateSpanId();
    const traceparent = `${context.version}-${context.traceId}-${childSpanId}-${context.traceFlags}`;

    const headers: Record<string, string> = {
      ...targetHeaders,
      [W3C_TRACEPARENT_HEADER]: traceparent,
      'x-trace-id': context.traceId,
    };

    if (context.traceState) {
      headers[W3C_TRACESTATE_HEADER] = context.traceState;
    }

    return headers;
  }
}

export const defaultDistributedTracer = new DistributedTracer();
