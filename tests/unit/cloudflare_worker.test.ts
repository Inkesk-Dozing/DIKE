import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { computePayloadFingerprint, Env, KVNamespace } from '../../plugins/cloudflare-worker/src/index';

class MockKVNamespace implements KVNamespace {
  private store = new Map<string, string>();

  async get(key: string, type?: 'text' | 'json'): Promise<any> {
    const val = this.store.get(key);
    if (!val) return null;
    if (type === 'json') return JSON.parse(val);
    return val;
  }

  async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

describe('Cloudflare Edge Worker Idempotency Gate (#66)', () => {
  let mockKV: MockKVNamespace;
  let env: Env;

  beforeEach(() => {
    mockKV = new MockKVNamespace();
    env = {
      DIKE_KV: mockKV,
      ORIGIN_URL: 'https://origin.internal.api',
      LEASE_TTL_SECONDS: 3600,
    };
  });

  it('computes deterministic SHA-256 fingerprint using Web Crypto API', async () => {
    const encoder = new TextEncoder();
    const body1 = encoder.encode(JSON.stringify({ charge: 100 }));
    const body2 = encoder.encode(JSON.stringify({ charge: 100 }));
    const body3 = encoder.encode(JSON.stringify({ charge: 200 }));

    const hash1 = await computePayloadFingerprint('POST', '/v1/charge', body1);
    const hash2 = await computePayloadFingerprint('POST', '/v1/charge', body2);
    const hash3 = await computePayloadFingerprint('POST', '/v1/charge', body3);
    const hash4 = await computePayloadFingerprint('PUT', '/v1/charge', body1);

    expect(hash1.length).toBe(64);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).not.toBe(hash4);
  });

  it('bypasses non-mutating GET requests directly to origin', async () => {
    const originFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    );
    vi.stubGlobal('fetch', originFetch);

    const req = new Request('https://gateway.example.com/v1/health', {
      method: 'GET',
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(originFetch).toHaveBeenCalledOnce();
    expect(res.headers.get('Idempotency-Status')).toBeNull();
  });

  it('executes full 3-phase edge lifecycle: MISS (Origin Pass), HIT (Edge Cache <15ms), MISMATCH (422)', async () => {
    let originInvocationCount = 0;
    const originFetch = vi.fn().mockImplementation(async (_url, init) => {
      originInvocationCount++;
      return new Response(JSON.stringify({ order_id: 'ord_edge_123', total: 500 }), {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          'ETag': '"edge-etag-001"',
        },
      });
    });
    vi.stubGlobal('fetch', originFetch);

    const idempotencyKey = 'cf-idem-test-key-001';
    const originalBody = JSON.stringify({ item: 'headphones', qty: 2 });

    // Phase 1: Fresh Request (MISS) -> Forwards to Origin and Caches in Edge KV
    const req1 = new Request('https://gateway.example.com/v1/orders', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
        'X-Tenant-Id': 'tenant_stripe',
      },
      body: originalBody,
    });

    const res1 = await worker.fetch(req1, env);
    expect(res1.status).toBe(201);
    expect(res1.headers.get('Idempotency-Status')).toBe('MISS');
    expect(res1.headers.get('X-Dike-Edge-Cache')).toBe('MISS');
    expect(originInvocationCount).toBe(1);

    const data1 = await res1.json();
    expect(data1.order_id).toBe('ord_edge_123');

    // Phase 2: Duplicate Request (HIT) -> Edge Cache Short-Circuit (Zero Origin Traffic)
    const startTime = performance.now();
    const req2 = new Request('https://gateway.example.com/v1/orders', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
        'X-Tenant-Id': 'tenant_stripe',
      },
      body: originalBody,
    });

    const res2 = await worker.fetch(req2, env);
    const edgeElapsed = performance.now() - startTime;

    // Acceptance criterion: Executes in < 15ms at edge
    expect(edgeElapsed).toBeLessThan(15);
    expect(res2.status).toBe(201);
    expect(res2.headers.get('Idempotency-Status')).toBe('HIT');
    expect(res2.headers.get('X-Dike-Edge-Cache')).toBe('HIT');
    expect(originInvocationCount).toBe(1); // Origin was NOT touched

    const data2 = await res2.json();
    expect(data2.order_id).toBe('ord_edge_123');

    // Phase 3: Mutated Payload Reuse (MISMATCH) -> 422 Problem Details
    const mutatedBody = JSON.stringify({ item: 'headphones', qty: 99 });
    const req3 = new Request('https://gateway.example.com/v1/orders', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
        'X-Tenant-Id': 'tenant_stripe',
      },
      body: mutatedBody,
    });

    const res3 = await worker.fetch(req3, env);
    expect(res3.status).toBe(422);
    expect(res3.headers.get('Idempotency-Status')).toBe('MISMATCH');
    expect(originInvocationCount).toBe(1); // Origin was NOT touched

    const data3 = await res3.json();
    expect(data3.detail).toContain('mutated payload fingerprint');
  });

  it('returns HTTP 409 Conflict when concurrent mutation is PENDING at edge', async () => {
    const idempotencyKey = 'cf-idem-pending-key';
    const body = JSON.stringify({ transfer: 1000 });
    const fingerprint = await computePayloadFingerprint(
      'POST',
      '/v1/transfer',
      new TextEncoder().encode(body)
    );

    // Pre-populate KV with PENDING record
    await mockKV.put(
      `dike:tenant_bank:${idempotencyKey}`,
      JSON.stringify({
        status: 'PENDING',
        fingerprint,
        createdAt: Date.now(),
      })
    );

    const req = new Request('https://gateway.example.com/v1/transfer', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Tenant-Id': 'tenant_bank',
        'Content-Type': 'application/json',
      },
      body,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(409);
    expect(res.headers.get('Idempotency-Status')).toBe('PARKED');
    expect(res.headers.get('Retry-After')).toBe('1');
  });
});
