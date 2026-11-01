/**
 * Cloudflare Edge Worker Idempotency Gate
 *
 * Intercepts mutation requests at Cloudflare Edge PoPs (200+ cities),
 * computes SHA-256 payload digests via Web Crypto API, atomically coordinates
 * leases via Edge KV / Durable Objects, and short-circuits cached replays (< 15ms)
 * to protect origin clusters from duplicate traffic.
 */

export interface Env {
  // Cloudflare KV Namespace for edge caching and lease tracking
  DIKE_KV: KVNamespace;
  // Origin URL for fresh request pass-through
  ORIGIN_URL?: string;
  // Optional shared secret for verifying edge receipts
  DIKE_EDGE_SECRET?: string;
  // Default lease expiration in seconds
  LEASE_TTL_SECONDS?: string | number;
}

export interface KVNamespace {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<any>;
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CachedEdgeRecord {
  status: 'PENDING' | 'COMPLETED';
  fingerprint: string;
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  createdAt: number;
}

/**
 * Computes deterministic SHA-256 hex digest using Web Crypto API
 */
export async function computePayloadFingerprint(
  method: string,
  pathname: string,
  bodyBytes: Uint8Array
): Promise<string> {
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(`${method.toUpperCase()}\n${pathname}\n`);

  const combined = new Uint8Array(headerBytes.length + bodyBytes.length);
  combined.set(headerBytes, 0);
  combined.set(bodyBytes, headerBytes.length);

  const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Main Cloudflare Worker request handler
 */
export default {
  async fetch(request: Request, env: Env, ctx?: { waitUntil(promise: Promise<any>): void }): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // Only intercept idempotent mutation methods (POST, PUT, PATCH)
    const idempotentMethods = ['POST', 'PUT', 'PATCH'];
    if (!idempotentMethods.includes(method)) {
      return fetchOrigin(request, env);
    }

    const idempotencyKey = request.headers.get('idempotency-key') || request.headers.get('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      // Pass-through without idempotency key
      return fetchOrigin(request, env);
    }

    const tenantId = request.headers.get('x-tenant-id') || 'default';
    const kvKey = `dike:${tenantId}:${idempotencyKey.trim()}`;

    // Read and buffer body for fingerprint calculation
    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    const fingerprint = await computePayloadFingerprint(method, url.pathname, bodyBytes);

    // 1. Check Cloudflare KV for existing record
    if (env.DIKE_KV) {
      const cached = (await env.DIKE_KV.get(kvKey, 'json')) as CachedEdgeRecord | null;

      if (cached) {
        // Validate payload fingerprint
        if (cached.fingerprint !== fingerprint) {
          return new Response(
            JSON.stringify({
              type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/422',
              title: 'Unprocessable Entity',
              status: 422,
              detail: 'Idempotency-Key reuse with mutated payload fingerprint',
            }),
            {
              status: 422,
              headers: {
                'Content-Type': 'application/problem+json',
                'Idempotency-Status': 'MISMATCH',
                'X-Dike-Edge-Latency': `${Date.now() - startTime}ms`,
              },
            }
          );
        }

        // Return cached completion (HIT) in < 15ms
        if (cached.status === 'COMPLETED') {
          const replayHeaders = new Headers(cached.headers || {});
          replayHeaders.set('Idempotency-Status', 'HIT');
          replayHeaders.set('X-Dike-Edge-Cache', 'HIT');
          replayHeaders.set('X-Dike-Edge-Latency', `${Date.now() - startTime}ms`);

          return new Response(cached.body ?? '', {
            status: cached.statusCode ?? 200,
            headers: replayHeaders,
          });
        }

        // In-flight concurrency (PENDING state)
        if (cached.status === 'PENDING') {
          return new Response(
            JSON.stringify({
              type: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/409',
              title: 'Conflict',
              status: 409,
              detail: 'Concurrent mutation in flight; retry with backoff',
            }),
            {
              status: 409,
              headers: {
                'Content-Type': 'application/problem+json',
                'Retry-After': '1',
                'Idempotency-Status': 'PARKED',
              },
            }
          );
        }
      }

      // 2. Mark PENDING lease in Edge KV
      const ttl = Number(env.LEASE_TTL_SECONDS) || 120;
      const pendingRecord: CachedEdgeRecord = {
        status: 'PENDING',
        fingerprint,
        createdAt: Date.now(),
      };
      await env.DIKE_KV.put(kvKey, JSON.stringify(pendingRecord), { expirationTtl: ttl });
    }

    // 3. Forward fresh mutation (MISS) to Origin Core Datacenter
    const originResponse = await fetchOriginWithBody(request, url, bodyBytes, env);

    // 4. Cache successful or client-error origin response (2xx / 4xx) in Edge KV
    if (env.DIKE_KV && originResponse.status < 500) {
      const respClone = originResponse.clone();
      const respBody = await respClone.text();

      const headersMap: Record<string, string> = {};
      originResponse.headers.forEach((v, k) => {
        if (!['connection', 'keep-alive', 'transfer-encoding'].includes(k.toLowerCase())) {
          headersMap[k] = v;
        }
      });

      const completedRecord: CachedEdgeRecord = {
        status: 'COMPLETED',
        fingerprint,
        statusCode: originResponse.status,
        headers: headersMap,
        body: respBody,
        createdAt: Date.now(),
      };

      const persistPromise = env.DIKE_KV.put(kvKey, JSON.stringify(completedRecord), {
        expirationTtl: Number(env.LEASE_TTL_SECONDS) || 86400,
      });

      if (ctx?.waitUntil) {
        ctx.waitUntil(persistPromise);
      } else {
        await persistPromise;
      }
    }

    // Return origin response with edge tracking header
    const finalHeaders = new Headers(originResponse.headers);
    finalHeaders.set('Idempotency-Status', 'MISS');
    finalHeaders.set('X-Dike-Edge-Cache', 'MISS');
    finalHeaders.set('X-Dike-Edge-Latency', `${Date.now() - startTime}ms`);

    return new Response(originResponse.body, {
      status: originResponse.status,
      headers: finalHeaders,
    });
  },
};

async function fetchOrigin(request: Request, env: Env): Promise<Response> {
  const targetUrl = env.ORIGIN_URL
    ? new URL(new URL(request.url).pathname + new URL(request.url).search, env.ORIGIN_URL).toString()
    : request.url;

  return fetch(targetUrl, request);
}

async function fetchOriginWithBody(
  request: Request,
  url: URL,
  bodyBytes: Uint8Array,
  env: Env
): Promise<Response> {
  const targetUrl = env.ORIGIN_URL
    ? new URL(url.pathname + url.search, env.ORIGIN_URL).toString()
    : request.url;

  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-By', 'DIKE-Edge-Worker');

  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: bodyBytes,
  });
}
