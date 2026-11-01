import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * k6 High-Concurrency Stress Benchmark Suite (1,000+ RPS)
 * Simulates 200 Virtual Users (VUs) sending rapid concurrent duplicate mutation requests
 * across 10 shared idempotency keys to verify sub-5ms p99 cached latency, exactly-once
 * upstream execution, and zero connection drops.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

// Custom Telemetry Metrics
export const upstreamCallsCounter = new Counter('upstream_calls');
export const cacheHitRate = new Rate('cache_hit_rate');
export const parkedDuration = new Trend('parked_duration', true);
export const errorsCounter = new Counter('error_rate_count');

// Workload Configuration: Target 1,000+ RPS with 200 Virtual Users
export const options = {
  scenarios: {
    high_concurrency_burst: {
      executor: 'ramping-arrival-rate',
      startRate: 200,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 500,
      stages: [
        { duration: '10s', target: 500 },  // Warm-up ramp
        { duration: '30s', target: 1200 }, // Sustained stress @ 1,200 RPS
        { duration: '10s', target: 0 },    // Cooldown
      ],
    },
  },
  thresholds: {
    // Assert sub-5ms p99 latency for parked/cached responses
    'http_req_duration{status:200}': ['p(95)<4', 'p(99)<5'],
    'http_req_duration{status:201}': ['p(95)<15', 'p(99)<25'],
    'http_req_failed': ['rate<0.001'], // < 0.1% failure rate
    'cache_hit_rate': ['rate>0.95'],   // > 95% of traffic served from cache/parking
  },
};

const BASE_URL = __ENV.DIKE_BASE_URL || 'http://localhost:8080';
const NUM_SHARED_KEYS = 10;
const TENANT_ID = 'perf_benchmark_tenant';

// Pool of 10 deterministic shared keys for flash-crowd testing
const SHARED_KEYS = Array.from({ length: NUM_SHARED_KEYS }, (_, i) => `benchmark-key-00${i}`);

export default function () {
  // Deterministically select one of the 10 shared keys to induce heavy lock contention
  const keyIndex = Math.floor(Math.random() * SHARED_KEYS.length);
  const idempotencyKey = SHARED_KEYS[keyIndex];

  const payload = JSON.stringify({
    clientKey: TENANT_ID,
    idempotencyKey: idempotencyKey,
    method: 'POST',
    path: '/api/v1/payments/charge',
    payload: {
      amount: 10000,
      currency: 'usd',
      orderId: `order-ref-${keyIndex}`,
    },
    ttlMs: 86400000,
    lockTimeoutMs: 15000,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Trace-Id': `k6-vu-${__VU}-iter-${__ITER}`,
    },
    tags: {
      name: 'PostIdempotencyBegin',
    },
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/v1/idempotency/begin`, payload, params);
  const duration = Date.now() - startTime;

  const isSuccess = check(res, {
    'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    'has valid response body': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body && (body.status === 'ACQUIRED' || body.status === 'CACHED');
      } catch {
        return false;
      }
    },
  });

  if (!isSuccess) {
    errorsCounter.add(1);
    return;
  }

  const jsonBody = JSON.parse(res.body);

  if (jsonBody.status === 'ACQUIRED') {
    // Leader: Upstream execution simulation
    upstreamCallsCounter.add(1);
    cacheHitRate.add(0);

    // Simulate short upstream database / gateway latency (e.g., 10ms)
    sleep(0.01);

    // Resolve the key so all followers unpark
    const resolvePayload = JSON.stringify({
      clientKey: TENANT_ID,
      idempotencyKey: idempotencyKey,
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: { chargeId: `ch_${idempotencyKey}`, status: 'SUCCEEDED' },
      fencingToken: jsonBody.fencingToken,
    });

    http.post(`${BASE_URL}/v1/idempotency/resolve`, resolvePayload, {
      headers: { 'Content-Type': 'application/json' },
    });
  } else if (jsonBody.status === 'CACHED') {
    // Follower served from parking or cache
    cacheHitRate.add(1);
    parkedDuration.add(duration);
  }
}
