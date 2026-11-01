import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Envoy WebAssembly (WASM) Filter Architecture (#62)', () => {
  let wasmBytes: Buffer;
  let wasmModule: WebAssembly.WebAssemblyInstantiatedSource;
  const logs: string[] = [];

  beforeAll(async () => {
    const wasmPath = path.resolve(
      __dirname,
      '../../plugins/envoy-wasm/target/wasm32-unknown-unknown/release/dike_envoy_wasm.wasm'
    );
    expect(fs.existsSync(wasmPath)).toBe(true);
    wasmBytes = fs.readFileSync(wasmPath);
  });

  it('compiles to < 2MB optimized WebAssembly binary', () => {
    const sizeInBytes = wasmBytes.length;
    const sizeInMB = sizeInBytes / (1024 * 1024);
    // Acceptance criterion: < 2MB
    expect(sizeInMB).toBeLessThan(2.0);
    // Actual size is ~160KB
    expect(sizeInBytes).toBeGreaterThan(1000);
  });

  it('exports compliant proxy-wasm ABI v0.2.1 interface symbols', async () => {
    let memory: WebAssembly.Memory;

    const envProxy = new Proxy({}, {
      get: (_target, prop: string) => {
        if (prop === 'proxy_log') {
          return (_level: number, ptr: number, size: number) => {
            if (memory) {
              const str = Buffer.from(memory.buffer, ptr, size).toString('utf8');
              logs.push(str);
            }
            return 0;
          };
        }
        return (..._args: unknown[]) => 0;
      },
    });

    wasmModule = await WebAssembly.instantiate(wasmBytes, { env: envProxy });
    memory = wasmModule.instance.exports.memory as WebAssembly.Memory;

    const exports = wasmModule.instance.exports as Record<string, any>;

    expect(exports).toBeDefined();
    expect(typeof exports['proxy_abi_version_0_2_1']).toBe('function');
    expect(typeof exports['proxy_on_vm_start']).toBe('function');
    expect(typeof exports['proxy_on_configure']).toBe('function');
    expect(typeof exports['proxy_on_context_create']).toBe('function');
    expect(typeof exports['proxy_on_request_headers']).toBe('function');
    expect(typeof exports['proxy_on_request_body']).toBe('function');
    expect(typeof exports['proxy_on_response_headers']).toBe('function');
    expect(typeof exports['proxy_on_response_body']).toBe('function');
  });

  it('executes proxy_on_vm_start and context lifecycle without memory corruption', () => {
    const exports = wasmModule.instance.exports as Record<string, any>;

    // Call _initialize if exported
    if (typeof exports['_initialize'] === 'function') {
      exports['_initialize']();
    }

    // 1. Create root context (id: 1, root_id: 0)
    exports['proxy_on_context_create'](1, 0);

    // 2. Start VM for root context
    const vmStartRes = exports['proxy_on_vm_start'](1, 0);
    expect(vmStartRes).toBe(1); // 1 = true in proxy-wasm ABI
    expect(logs.some((l) => l.includes('DIKE Envoy WASM VM initialized successfully'))).toBe(true);

    // 3. Configure plugin
    const configureRes = exports['proxy_on_configure'](1, 0);
    expect(configureRes).toBe(1);

    // 4. Create HTTP stream context (id: 2, root_id: 1)
    expect(() => {
      exports['proxy_on_context_create'](2, 1);
    }).not.toThrow();

    // 5. Invoke request headers hook
    const reqHeadersAction = exports['proxy_on_request_headers'](2, 0, 1);
    expect(reqHeadersAction).toBe(0); // Action::Continue = 0

    // 6. Invoke request body hook
    const reqBodyAction = exports['proxy_on_request_body'](2, 0, 1);
    expect(reqBodyAction).toBe(0); // Action::Continue = 0

    // 7. Invoke response headers hook
    const respHeadersAction = exports['proxy_on_response_headers'](2, 0, 1);
    expect(respHeadersAction).toBe(0); // Action::Continue = 0

    // 8. Invoke response body hook
    const respBodyAction = exports['proxy_on_response_body'](2, 0, 1);
    expect(respBodyAction).toBe(0); // Action::Continue = 0

    // 9. Clean up contexts
    exports['proxy_on_done'](2);
    exports['proxy_on_delete'](2);
    exports['proxy_on_done'](1);
    exports['proxy_on_delete'](1);
  });
});
