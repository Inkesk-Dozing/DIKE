/**
 * Upstream Request Dispatcher and Connection Forwarder for DIKE
 * Transparently relays client requests to backend services with sub-millisecond overhead,
 * preserving original HTTP methods, headers, cookies, and injecting W3C traceparents.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyRequest } from 'fastify';
import { defaultLogger } from '../utils/logger.js';
import { defaultDistributedTracer, W3C_TRACEPARENT_HEADER, W3C_TRACESTATE_HEADER } from '../telemetry/tracing.js';

export interface UpstreamConfig {
  /**
   * Upstream backend target URL base (e.g. 'http://backend.internal:8080').
   */
  readonly targetUrl: string;
  /**
   * Request timeout in milliseconds. Defaults to 30,000ms.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Custom request headers to append to all forwarded requests.
   */
  readonly customHeaders?: Record<string, string> | undefined;
}

export interface UpstreamResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly readableStream: any;
}

export class UpstreamDispatcher {
  private readonly targetUrl: string;
  private readonly timeoutMs: number;
  private readonly customHeaders: Record<string, string>;

  constructor(config: UpstreamConfig) {
    if (!config.targetUrl) {
      throw new Error('UpstreamDispatcher requires a valid targetUrl.');
    }
    this.targetUrl = config.targetUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.customHeaders = config.customHeaders ?? {};
  }

  /**
   * Normalizes inbound Fastify headers into forwarded request headers:
   * preserves cookies, authorization, host, appends X-Forwarded-*, and injects W3C traceparent.
   */
  public prepareForwardHeaders(req: FastifyRequest): Record<string, string> {
    const forwardHeaders: Record<string, string> = { ...this.customHeaders };

    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lowerKey = key.toLowerCase();

      // Skip hop-by-hop headers
      if (
        lowerKey === 'connection' ||
        lowerKey === 'keep-alive' ||
        lowerKey === 'transfer-encoding' ||
        lowerKey === 'te' ||
        lowerKey === 'upgrade'
      ) {
        continue;
      }

      forwardHeaders[lowerKey] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    // Forwarding client provenance headers
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const existingXff = req.headers['x-forwarded-for'];
    forwardHeaders['x-forwarded-for'] = existingXff
      ? `${existingXff}, ${clientIp}`
      : clientIp;

    forwardHeaders['x-forwarded-proto'] =
      (req.headers['x-forwarded-proto'] as string) || (req.protocol ?? 'http');

    forwardHeaders['x-forwarded-host'] =
      (req.headers['x-forwarded-host'] as string) || (req.headers.host ?? 'localhost');

    // Ensure trace ID correlation and W3C traceparent are propagated
    if (req.traceContext) {
      Object.assign(forwardHeaders, defaultDistributedTracer.injectHeaders(req.traceContext));
    } else if (req.traceId) {
      forwardHeaders['x-trace-id'] = req.traceId;
    }

    return forwardHeaders;
  }

  /**
   * Forwards an inbound request directly to the upstream target URL using native fetch.
   */
  public async forward(
    req: FastifyRequest,
    payloadOverride?: Buffer | string | object | undefined
  ): Promise<UpstreamResponse> {
    const forwardUrl = `${this.targetUrl}${req.url}`;
    const headers = this.prepareForwardHeaders(req);

    // Determine payload body
    let bodyData: any = undefined;
    const methodUpper = req.method.toUpperCase();
    const canHaveBody = methodUpper !== 'GET' && methodUpper !== 'HEAD';

    if (canHaveBody) {
      if (payloadOverride !== undefined) {
        if (typeof payloadOverride === 'string' || Buffer.isBuffer(payloadOverride)) {
          bodyData = payloadOverride;
        } else {
          bodyData = JSON.stringify(payloadOverride);
        }
      } else if (req.body !== undefined && req.body !== null) {
        if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
          bodyData = req.body;
        } else {
          bodyData = JSON.stringify(req.body);
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const startTime = Date.now();
    defaultLogger.debug({
      msg: 'Forwarding request to upstream',
      method: req.method,
      url: forwardUrl,
      traceId: req.traceId,
    });

    try {
      const response = await fetch(forwardUrl, {
        method: req.method,
        headers,
        body: bodyData,
        signal: controller.signal,
      });

      const arrayBuf = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      const elapsedMs = Date.now() - startTime;

      defaultLogger.debug({
        msg: 'Upstream response received',
        statusCode: response.status,
        elapsedMs,
        traceId: req.traceId,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        responseHeaders[key.toLowerCase()] = val;
      });

      return {
        statusCode: response.status,
        headers: responseHeaders,
        body: buffer,
        readableStream: response.body,
      };
    } catch (err: any) {
      defaultLogger.error({
        msg: 'Upstream request failed',
        forwardUrl,
        err,
        traceId: req.traceId,
      });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
