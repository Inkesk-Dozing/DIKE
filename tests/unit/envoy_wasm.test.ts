import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Envoy Asynchronous Redis Client via Envoy Cluster Protocol (#64)', () => {
  let wasmBytes: Buffer;
  const logs: string[] = [];

  function createEnv(handlers: Record<string, Function>) {
    return new Proxy({}, {
      get: (_target, prop: string) => {
        if (handlers[prop]) {
          return handlers[prop];
        }
        return (..._args: unknown[]) => 0;
      },
      has: () => true,
    });
  }

  beforeAll(async () => {
    const wasmPath = path.resolve(
      __dirname,
      '../../plugins/envoy-wasm/target/wasm32-unknown-unknown/release/dike_envoy_wasm.wasm'
    );
    expect(fs.existsSync(wasmPath)).toBe(true);
    wasmBytes = fs.readFileSync(wasmPath);
  });

  it('compiles with async cluster dispatch protocol to < 2MB binary', () => {
    const sizeInMB = wasmBytes.length / (1024 * 1024);
    expect(sizeInMB).toBeLessThan(2.0);
    // ~204KB
    expect(wasmBytes.length).toBeGreaterThan(50_000);
  });

  it('dispatches async HTTP call to DIKE cluster on request body completion and pauses stream', async () => {
    let memory: WebAssembly.Memory;
    let exports: Record<string, any>;
    let dispatchedCluster: string | null = null;
    let dispatchedBody: string | null = null;
    let dispatchedTimeoutMs: number | null = null;

    const mockHeaders: Record<string, string> = {
      'idempotency-key': 'idem-cluster-test-1',
      ':method': 'POST',
      ':path': '/v1/charge',
      'x-tenant-id': 'tenant_enterprise',
    };

    const requestBody = Buffer.from(JSON.stringify({ amount: 100 }));

    const env = createEnv({
      proxy_log: (_level: number, ptr: number, size: number) => {
        if (memory) {
          logs.push(Buffer.from(memory.buffer, ptr, size).toString('utf8'));
        }
        return 0;
      },
      proxy_get_buffer_bytes: (type: number, start: number, length: number, ptrPtr: number, sizePtr: number) => {
        if (type === 7) {
          const cfg = Buffer.from(JSON.stringify({
            idempotency_header: 'idempotency-key',
            tenant_header: 'x-tenant-id',
            dike_cluster: 'redis-cluster',
            timeout_ms: 3000,
          }));
          const ptr = exports['malloc'](cfg.length);
          new Uint8Array(memory.buffer, ptr, cfg.length).set(cfg);
          new DataView(memory.buffer).setUint32(ptrPtr, ptr, true);
          new DataView(memory.buffer).setUint32(sizePtr, cfg.length, true);
          return 0;
        }
        if (type === 2) {
          const chunk = requestBody.subarray(start, start + length);
          const heapPtr = exports['malloc'](chunk.length);
          new Uint8Array(memory.buffer, heapPtr, chunk.length).set(chunk);
          new DataView(memory.buffer).setUint32(ptrPtr, heapPtr, true);
          new DataView(memory.buffer).setUint32(sizePtr, chunk.length, true);
          return 0;
        }
        return 1;
      },
      proxy_get_header_map_value: (_type: number, keyPtr: number, keySize: number, valPtrPtr: number, valSizePtr: number) => {
        const headerName = Buffer.from(memory.buffer, keyPtr, keySize).toString('utf8').toLowerCase();
        const val = mockHeaders[headerName];
        if (val) {
          const valBuf = Buffer.from(val, 'utf8');
          const heapPtr = exports['malloc'](valBuf.length);
          new Uint8Array(memory.buffer, heapPtr, valBuf.length).set(valBuf);
          new DataView(memory.buffer).setUint32(valPtrPtr, heapPtr, true);
          new DataView(memory.buffer).setUint32(valSizePtr, valBuf.length, true);
          return 0;
        }
        return 1;
      },
      proxy_http_call: (
        clusterPtr: number,
        clusterSize: number,
        _headersPtr: number,
        _headersSize: number,
        bodyPtr: number,
        bodySize: number,
        _trailersPtr: number,
        _trailersSize: number,
        timeout: number,
        tokenPtr: number
      ) => {
        dispatchedCluster = Buffer.from(memory.buffer, clusterPtr, clusterSize).toString('utf8');
        dispatchedBody = Buffer.from(memory.buffer, bodyPtr, bodySize).toString('utf8');
        dispatchedTimeoutMs = timeout;
        new DataView(memory.buffer).setUint32(tokenPtr, 777, true);
        return 0;
      },
    });

    const inst = await WebAssembly.instantiate(wasmBytes, { env });
    exports = inst.instance.exports as Record<string, any>;
    memory = exports['memory'] as WebAssembly.Memory;

    if (typeof exports['_initialize'] === 'function') exports['_initialize']();

    exports['proxy_on_context_create'](1, 0);
    exports['proxy_on_vm_start'](1, 0);
    exports['proxy_on_configure'](1, 40);
    exports['proxy_on_context_create'](2, 1);

    exports['proxy_on_request_headers'](2, 3, 0);
    const bodyAction = exports['proxy_on_request_body'](2, requestBody.length, 1);

    expect(bodyAction).toBe(1); // Action::Pause = 1
    expect(dispatchedCluster).toBe('redis-cluster');
    expect(dispatchedTimeoutMs).toBe(3000);
    expect(dispatchedBody).toBeDefined();

    const checkReq = JSON.parse(dispatchedBody!);
    expect(checkReq.tenant_id).toBe('tenant_enterprise');
    expect(checkReq.idempotency_key).toBe('idem-cluster-test-1');
    expect(checkReq.payload_hash.length).toBe(64);
  });

  it('short-circuits cached response on LeaseStatus::Hit without stalling worker thread', async () => {
    let memory: WebAssembly.Memory;
    let exports: Record<string, any>;
    let sentLocalResponse: { status: number; body?: string } | null = null;

    const cachedPayload = JSON.stringify({
      status: 'Hit',
      cached_status_code: 200,
      cached_headers: { 'content-type': 'application/json' },
      cached_body: JSON.stringify({ success: true, transaction_id: 'tx_replayed' }),
    });

    const env = createEnv({
      proxy_get_buffer_bytes: (type: number, _start: number, _length: number, ptrPtr: number, sizePtr: number) => {
        if (type === 7) {
          const cfg = Buffer.from(JSON.stringify({ dike_cluster: 'redis-cluster' }));
          const ptr = exports['malloc'](cfg.length);
          new Uint8Array(memory.buffer, ptr, cfg.length).set(cfg);
          new DataView(memory.buffer).setUint32(ptrPtr, ptr, true);
          new DataView(memory.buffer).setUint32(sizePtr, cfg.length, true);
          return 0;
        }
        if (type === 4 || type === 5) {
          // HttpCallResponseBody = 5
          const respBuf = Buffer.from(cachedPayload, 'utf8');
          const ptr = exports['malloc'](respBuf.length);
          new Uint8Array(memory.buffer, ptr, respBuf.length).set(respBuf);
          new DataView(memory.buffer).setUint32(ptrPtr, ptr, true);
          new DataView(memory.buffer).setUint32(sizePtr, respBuf.length, true);
          return 0;
        }
        return 1;
      },
      proxy_get_header_map_value: (_type: number, keyPtr: number, keySize: number, valPtrPtr: number, valSizePtr: number) => {
        const headerName = Buffer.from(memory.buffer, keyPtr, keySize).toString('utf8').toLowerCase();
        if (headerName === 'idempotency-key') {
          const valBuf = Buffer.from('test-hit-key', 'utf8');
          const heapPtr = exports['malloc'](valBuf.length);
          new Uint8Array(memory.buffer, heapPtr, valBuf.length).set(valBuf);
          new DataView(memory.buffer).setUint32(valPtrPtr, heapPtr, true);
          new DataView(memory.buffer).setUint32(valSizePtr, valBuf.length, true);
          return 0;
        }
        return 1;
      },
      proxy_http_call: (_1: any, _2: any, _3: any, _4: any, _5: any, _6: any, _7: any, _8: any, _9: any, tokenPtr: number) => {
        new DataView(memory.buffer).setUint32(tokenPtr, 888, true);
        return 0;
      },
      proxy_send_local_response: (status: number, _1: any, _2: any, bodyPtr: number, bodySize: number) => {
        const body = bodyPtr !== 0 && bodySize > 0
          ? Buffer.from(memory.buffer, bodyPtr, bodySize).toString('utf8')
          : undefined;
        sentLocalResponse = { status, body };
        return 0;
      },
    });

    const inst = await WebAssembly.instantiate(wasmBytes, { env });
    exports = inst.instance.exports as Record<string, any>;
    memory = exports['memory'] as WebAssembly.Memory;

    if (typeof exports['_initialize'] === 'function') exports['_initialize']();

    exports['proxy_on_context_create'](10, 0);
    exports['proxy_on_vm_start'](10, 0);
    exports['proxy_on_configure'](10, 40);
    exports['proxy_on_context_create'](20, 10);

    exports['proxy_on_request_headers'](20, 1, 0);
    exports['proxy_on_request_body'](20, 10, 1);

    // Invoke async cluster callback with token 888
    exports['proxy_on_http_call_response'](20, 888, 0, cachedPayload.length, 0);

    expect(sentLocalResponse).not.toBeNull();
    expect(sentLocalResponse!.status).toBe(200);
    expect(sentLocalResponse!.body).toContain('tx_replayed');
  });

  it('resumes downstream request towards upstream when LeaseStatus::Acquired', async () => {
    let memory: WebAssembly.Memory;
    let exports: Record<string, any>;
    let resumedHttpRequest = false;

    const acquiredPayload = JSON.stringify({
      status: 'Acquired',
      cached_status_code: null,
      cached_headers: null,
      cached_body: null,
    });

    const env = createEnv({
      proxy_get_buffer_bytes: (type: number, _start: number, _length: number, ptrPtr: number, sizePtr: number) => {
        if (type === 7) {
          const cfg = Buffer.from(JSON.stringify({ dike_cluster: 'redis-cluster' }));
          const ptr = exports['malloc'](cfg.length);
          new Uint8Array(memory.buffer, ptr, cfg.length).set(cfg);
          new DataView(memory.buffer).setUint32(ptrPtr, ptr, true);
          new DataView(memory.buffer).setUint32(sizePtr, cfg.length, true);
          return 0;
        }
        if (type === 4 || type === 5) {
          const respBuf = Buffer.from(acquiredPayload, 'utf8');
          const ptr = exports['malloc'](respBuf.length);
          new Uint8Array(memory.buffer, ptr, respBuf.length).set(respBuf);
          new DataView(memory.buffer).setUint32(ptrPtr, ptr, true);
          new DataView(memory.buffer).setUint32(sizePtr, respBuf.length, true);
          return 0;
        }
        return 1;
      },
      proxy_get_header_map_value: (_type: number, keyPtr: number, keySize: number, valPtrPtr: number, valSizePtr: number) => {
        const headerName = Buffer.from(memory.buffer, keyPtr, keySize).toString('utf8').toLowerCase();
        if (headerName === 'idempotency-key') {
          const valBuf = Buffer.from('test-acquired-key', 'utf8');
          const heapPtr = exports['malloc'](valBuf.length);
          new Uint8Array(memory.buffer, heapPtr, valBuf.length).set(valBuf);
          new DataView(memory.buffer).setUint32(valPtrPtr, heapPtr, true);
          new DataView(memory.buffer).setUint32(valSizePtr, valBuf.length, true);
          return 0;
        }
        return 1;
      },
      proxy_http_call: (_1: any, _2: any, _3: any, _4: any, _5: any, _6: any, _7: any, _8: any, _9: any, tokenPtr: number) => {
        new DataView(memory.buffer).setUint32(tokenPtr, 999, true);
        return 0;
      },
      proxy_continue_stream: () => {
        resumedHttpRequest = true;
        return 0;
      },
    });

    const inst = await WebAssembly.instantiate(wasmBytes, { env });
    exports = inst.instance.exports as Record<string, any>;
    memory = exports['memory'] as WebAssembly.Memory;

    if (typeof exports['_initialize'] === 'function') exports['_initialize']();

    exports['proxy_on_context_create'](100, 0);
    exports['proxy_on_vm_start'](100, 0);
    exports['proxy_on_configure'](100, 40);
    exports['proxy_on_context_create'](200, 100);

    exports['proxy_on_request_headers'](200, 1, 0);
    exports['proxy_on_request_body'](200, 10, 1);

    exports['proxy_on_http_call_response'](200, 999, 0, acquiredPayload.length, 0);

    expect(resumedHttpRequest).toBe(true);
  });
});
