/**
 * Selective Idempotency Interception & Pass-Through Pipeline for DIKE
 * Evaluates inbound HTTP requests against method mutation rules, presence of
 * Idempotency-Key headers, route exclusions, and strict mode compliance.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { IETF_IDEMPOTENCY_KEY_HEADER } from '../server/plugins/ietf_headers.js';

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'TRACE' | 'DELETE' | 'POST' | 'PUT' | 'PATCH';

export type InterceptionDecision =
  | {
      action: 'BYPASS';
      reason: 'SAFE_OR_IDEMPOTENT_METHOD' | 'EXCLUDED_PATH' | 'MISSING_KEY_NON_STRICT' | 'NO_STORAGE';
    }
  | {
      action: 'INTERCEPT';
      key: string;
      tenantId: string;
    }
  | {
      action: 'REJECT';
      statusCode: 400;
      message: string;
    };

export interface InterceptorOptions {
  /**
   * If true, mutation requests (POST, PUT, PATCH) lacking an Idempotency-Key
   * header will be rejected with HTTP 400 Bad Request. Default: false.
   */
  readonly strictMode?: boolean;
  /**
   * Set of HTTP methods considered mutations that can be intercepted.
   * Default: ['POST', 'PUT', 'PATCH']
   */
  readonly mutationMethods?: ReadonlyArray<string>;
  /**
   * Set of paths that bypass reverse proxy and idempotency interception.
   */
  readonly excludedPaths?: ReadonlyArray<string>;
  /**
   * Tenant identifier header name. Defaults to ['x-client-id', 'x-tenant-id'].
   */
  readonly tenantIdHeaders?: ReadonlyArray<string>;
  /**
   * Default tenant identifier if header is missing. Default: 'default_tenant'.
   */
  readonly defaultTenantId?: string;
}

export class IdempotencyInterceptor {
  private readonly strictMode: boolean;
  private readonly mutationMethods: Set<string>;
  private readonly excludedPaths: Set<string>;
  private readonly tenantIdHeaders: ReadonlyArray<string>;
  private readonly defaultTenantId: string;

  constructor(options: InterceptorOptions = {}) {
    this.strictMode = options.strictMode ?? false;
    this.mutationMethods = new Set(
      (options.mutationMethods ?? ['POST', 'PUT', 'PATCH']).map((m) => m.toUpperCase())
    );
    this.excludedPaths = new Set([
      '/healthz',
      '/readyz',
      '/drain',
      '/v1/idempotency/begin',
      '/v1/idempotency/resolve',
      '/v1/idempotency/abort',
      ...(options.excludedPaths ?? []),
    ]);
    this.tenantIdHeaders = options.tenantIdHeaders ?? ['x-client-id', 'x-tenant-id'];
    this.defaultTenantId = options.defaultTenantId ?? 'default_tenant';
  }

  /**
   * Inspects an incoming request and decides whether to bypass, intercept, or reject it.
   */
  public evaluate(req: FastifyRequest, hasStorage = true): InterceptionDecision {
    const pathname = (req.url || '/').split('?')[0] ?? '/';
    if (this.excludedPaths.has(pathname)) {
      return { action: 'BYPASS', reason: 'EXCLUDED_PATH' };
    }

    const method = req.method.toUpperCase();
    const isMutation = this.mutationMethods.has(method);

    if (!isMutation) {
      return { action: 'BYPASS', reason: 'SAFE_OR_IDEMPOTENT_METHOD' };
    }

    const rawKey = req.headers[IETF_IDEMPOTENCY_KEY_HEADER];
    const key = Array.isArray(rawKey) ? (rawKey[0] ?? '').trim() : typeof rawKey === 'string' ? rawKey.trim() : '';

    if (!key) {
      if (this.strictMode) {
        return {
          action: 'REJECT',
          statusCode: 400,
          message: `Idempotency-Key header is required for mutation method ${method} when strict mode is enabled.`,
        };
      }
      return { action: 'BYPASS', reason: 'MISSING_KEY_NON_STRICT' };
    }

    if (!hasStorage) {
      return { action: 'BYPASS', reason: 'NO_STORAGE' };
    }

    let tenantId = this.defaultTenantId;
    for (const h of this.tenantIdHeaders) {
      const val = req.headers[h.toLowerCase()];
      if (val) {
        tenantId = Array.isArray(val) ? val[0]! : val;
        break;
      }
    }

    return {
      action: 'INTERCEPT',
      key,
      tenantId,
    };
  }

  /**
   * Returns whether strict mode is enabled.
   */
  public isStrict(): boolean {
    return this.strictMode;
  }
}

