import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Envoy WASM HTTP Header & Streaming Body Digest Interceptor (#63)', () => {
  let wasmBytes: Buffer;
  const logs: string[] = [];
  const responseHeaders: Record<string, string> = {};

  beforeAll(async () => {
    const wasmPath = path.resolve(
      __dirname,
      '../../plugins/envoy-wasm/target/wasm32-unknown-unknown/release/dike_envoy_wasm.wasm'
    );
    expect(fs.existsSync(wasmPath)).toBe(true);
    wasmBytes = fs.readFileSync(wasmPath);
  });

  it('compiles with BLAKE3 digest engine to < 2MB binary', () => {
    const sizeInMB = wasmBytes.length / (1024 * 1024);
    expect(sizeInMB).toBeLessThan(2.0);
    // ~181KB
    expect(wasmBytes.length).toBeGreaterThan(50_000);
  });

  it('bypasses digestion when Idempotency-Key header is absent (Action::Continue)', async () => {
    let memory: WebAssembly.Memory;
    let exports: Record<string, any>;

    const envProxy = new Proxy({}, {
      get: (_target, prop: string) => {
        if (prop === 'proxy_log') {
          return (_level: number, ptr: number, size: number) => {
            if (memory) {
              logs.push(Buffer.from(memory.buffer, ptr, size).toString('utf8'));
            }
            return 0;
          };
        }
        if (prop === 'proxy_get_buffer_bytes') {
          return (type: number, _start: number, _length: number, ptrPtr: number, sizePtr: number) => {
            if (type === 7) {
              const cfg = Buffer.from(JSON.stringify({ idempotency_header: 'idempotency-key' }));
              const ptr = exports['malloc'](cfg.length);
              new Uint8Array(memory.buffer, ptr, cfg.length).set(cfg);
              new DataView(memory.buffer).setUint32(ptrPtr, ptr, true);
              new DataView(memory.buffer).setUint32(sizePtr, cfg.length, true);
              return 0;
            }
            return 1;
          };
        }
        if (prop === 'proxy_get_header_map_value') {
          // No idempotency-key header returned
          return () => 1; // NotFound
        }
        return (..._args: unknown[]) => 0;
      },
    });

    const inst = await WebAssembly.instantiate(wasmBytes, { env: envProxy });
    exports = inst.instance.exports as Record<string, any>;
    memory = exports['memory'] as WebAssembly.Memory;

    if (typeof exports['_initialize'] === 'function') exports['_initialize']();

    // Create Root and Stream contexts
    exports['proxy_on_context_create'](1, 0);
    exports['proxy_on_vm_start'](1, 0);
    exports['proxy_on_configure'](1, 40);
    exports['proxy_on_context_create'](2, 1);

    // Request headers without Idempotency-Key
    const headerAction = exports['proxy_on_request_headers'](2, 0, 0);
    expect(headerAction).toBe(0); // Action::Continue = 0

    // Request body without Idempotency-Key passes through immediately
    const bodyAction = exports['proxy_on_request_body'](2, 50, 1);
    expect(bodyAction).toBe(0); // Action::Continue = 0
  });

  it('pauses streaming body chunks when Idempotency-Key is present and computes payload digest', async () => {
    let memory: WebAssembly.Memory;
    let exports: Record<string, any>;

    const mockHeaders: Record<string, string> = {
      'idempotency-key': 'test-idem-key-999',
      ':method': 'POST',
      ':path': '/v1/payments/charge',
    };

    const requestBody = Buffer.from(JSON.stringify({ order_id: 'ord_123', amount: 5000 }));

    const envProxy = new Proxy({}, {
      get: (_target, prop: string) => {
        if (prop === 'proxy_log') {
          return (_level: number, ptr: number, size: number) => {
            if (memory) {
              logs.push(Buffer.from(memory.buffer, ptr, size).toString('utf8'));
            }
            return 0;
          };
        }
        if (prop === 'proxy_get_buffer_bytes') {
          return (type: number, start: number, length: number, ptrPtr: number, sizePtr: number) => {
            if (type === 7) {
              // PluginConfiguration
              const cfg = Buffer.from(JSON.stringify({ idempotency_header: 'idempotency-key' }));
              const ptr = exports['malloc'](cfg.length);
              new Uint8Array(memory.buffer, ptr, cfg.length).set(cfg);
              new DataView(memory.buffer).setUint32(ptrPtr, ptr, true);
              new DataView(memory.buffer).setUint32(sizePtr, cfg.length, true);
              return 0;
            }
            if (type === 2) {
              // HttpRequestBody
              const chunk = requestBody.subarray(start, start + length);
              const heapPtr = exports['malloc'](chunk.length);
              new Uint8Array(memory.buffer, heapPtr, chunk.length).set(chunk);
              new DataView(memory.buffer).setUint32(ptrPtr, heapPtr, true);
              new DataView(memory.buffer).setUint32(sizePtr, chunk.length, true);
              return 0;
            }
            return 1;
          };
        }
        if (prop === 'proxy_get_header_map_value') {
          return (_type: number, keyPtr: number, keySize: number, valPtrPtr: number, valSizePtr: number) => {
            const headerName = Buffer.from(memory.buffer, keyPtr, keySize).toString('utf8').toLowerCase();
            const val = mockHeaders[headerName];
            if (val) {
              const valBuf = Buffer.from(val, 'utf8');
              const heapPtr = exports['malloc'](valBuf.length);
              new Uint8Array(memory.buffer, heapPtr, valBuf.length).set(valBuf);
              new DataView(memory.buffer).setUint32(valPtrPtr, heapPtr, true);
              new DataView(memory.buffer).setUint32(valSizePtr, valBuf.length, true);
              return 0; // Ok
            }
            return 1; // NotFound
          };
        }
        if (prop === 'proxy_add_header_map_value' || prop === 'proxy_replace_header_map_value') {
          return (_type: number, kPtr: number, kSize: number, vPtr: number, vSize: number) => {
            const k = Buffer.from(memory.buffer, kPtr, kSize).toString('utf8');
            const v = Buffer.from(memory.buffer, vPtr, vSize).toString('utf8');
            responseHeaders[k] = v;
            return 0;
          };
        }
        return (..._args: unknown[]) => 0;
      },
    });

    const inst = await WebAssembly.instantiate(wasmBytes, { env: envProxy });
    exports = inst.instance.exports as Record<string, any>;
    memory = exports['memory'] as WebAssembly.Memory;

    if (typeof exports['_initialize'] === 'function') exports['_initialize']();

    // 1. Initialize root and configure
    exports['proxy_on_context_create'](10, 0);
    exports['proxy_on_vm_start'](10, 0);
    exports['proxy_on_configure'](10, 40);

    // 2. Create stream context
    exports['proxy_on_context_create'](20, 10);

    // 3. Request headers with Idempotency-Key
    const hdrAction = exports['proxy_on_request_headers'](20, 3, 0);
    expect(hdrAction).toBe(0); // Action::Continue to receive body

    // 4. First body chunk (streaming, end_of_stream = 0)
    const chunk1Size = 15;
    const chunk1Action = exports['proxy_on_request_body'](20, chunk1Size, 0);
    expect(chunk1Action).toBe(1); // Action::Pause = 1

    // 5. Final body chunk (end_of_stream = 1)
    const chunk2Size = requestBody.length - chunk1Size;
    const chunk2Action = exports['proxy_on_request_body'](20, chunk2Size, 1);
    expect(chunk2Action).toBe(1); // Action::Pause = 1 (Awaiting lease decision)

    // Verify debug logs recorded finalized BLAKE3 fingerprint
    const fpLog = logs.find((l) => l.includes('Finalized BLAKE3 fingerprint:'));
    expect(fpLog).toBeDefined();

    // 6. Response headers attaches mesh processing & payload digest
    exports['proxy_on_response_headers'](20, 0, 1);
    expect(responseHeaders['x-dike-mesh-processed']).toBe('true');
    expect(responseHeaders['x-dike-payload-digest']).toBeDefined();
    expect(responseHeaders['x-dike-payload-digest']?.length).toBe(64);
  });
});
