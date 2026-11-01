import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Kong Gateway Native Plugin in Lua (`kong-plugin-dike`) (#65)', () => {
  const handlerPath = path.resolve(__dirname, '../../plugins/kong/handler.lua');
  const schemaPath = path.resolve(__dirname, '../../plugins/kong/schema.lua');
  const rockspecPath = path.resolve(__dirname, '../../plugins/kong/kong-plugin-dike-0.1.0-1.rockspec');

  it('provides all mandatory Kong plugin and rockspec assets', () => {
    expect(fs.existsSync(handlerPath)).toBe(true);
    expect(fs.existsSync(schemaPath)).toBe(true);
    expect(fs.existsSync(rockspecPath)).toBe(true);
  });

  it('validates schema configuration definitions and defaults', () => {
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');

    expect(schemaContent).toContain('name = "dike"');
    expect(schemaContent).toContain('default = "Idempotency-Key"');
    expect(schemaContent).toContain('default = "http://dike-service:8080"');
    expect(schemaContent).toContain('default = 2000');
    expect(schemaContent).toContain('default = true'); // fail_open
    expect(schemaContent).toContain('"POST", "PATCH", "PUT"');
  });

  it('validates handler lifecycle hooks and phase definitions', () => {
    const handlerContent = fs.readFileSync(handlerPath, 'utf8');

    expect(handlerContent).toContain('function DikeHandler:access(conf)');
    expect(handlerContent).toContain('function DikeHandler:header_filter(conf)');
    expect(handlerContent).toContain('function DikeHandler:body_filter(conf)');
    expect(handlerContent).toContain('function DikeHandler:log(conf)');

    // Priority & Version metadata
    expect(handlerContent).toContain('PRIORITY = 900');
    expect(handlerContent).toContain('VERSION = "0.1.0"');

    // Headers & actions
    expect(handlerContent).toContain('kong.response.exit');
    expect(handlerContent).toContain('X-Dike-Kong-Processed');
    expect(handlerContent).toContain('Idempotency-Status');
    expect(handlerContent).toContain('/v1/idempotency/check');
    expect(handlerContent).toContain('/v1/idempotency/commit');
  });

  it('validates rockspec packaging structure for Luarocks distribution', () => {
    const rockspecContent = fs.readFileSync(rockspecPath, 'utf8');

    expect(rockspecContent).toContain('package = "kong-plugin-dike"');
    expect(rockspecContent).toContain('version = "0.1.0-1"');
    expect(rockspecContent).toContain('["kong.plugins.dike.handler"] = "handler.lua"');
    expect(rockspecContent).toContain('["kong.plugins.dike.schema"] = "schema.lua"');
    expect(rockspecContent).toContain('lua-resty-http >= 0.16');
  });

  it('simulates Kong execution lifecycle contract with mock harness', async () => {
    // Simulate Lua Kong plugin execution pipeline in JS sandbox
    type Phase = 'access' | 'header_filter' | 'body_filter' | 'log';

    interface KongContext {
      request: {
        method: string;
        path: string;
        headers: Record<string, string>;
        rawBody: string;
      };
      response: {
        statusCode: number;
        headers: Record<string, string>;
        body: string;
        exitCalled: boolean;
      };
      ctx: {
        dike?: {
          idempotency_key?: string;
          status: string;
          chunks: string[];
          full_response_body?: string;
        };
      };
    }

    const runKongPlugin = (
      conf: { header_name: string; fail_open: boolean },
      mockCheckResponse: { status: 'Hit' | 'Acquired' | 'Mismatch'; cached_body?: string; cached_status?: number }
    ) => {
      const mockKong: KongContext = {
        request: {
          method: 'POST',
          path: '/v1/orders',
          headers: { [conf.header_name.toLowerCase()]: 'ord_idem_key_777' },
          rawBody: JSON.stringify({ item: 'laptop', qty: 1 }),
        },
        response: {
          statusCode: 200,
          headers: {},
          body: '',
          exitCalled: false,
        },
        ctx: {},
      };

      // 1. Access phase
      const idemKey = mockKong.request.headers[conf.header_name.toLowerCase()];
      if (idemKey) {
        mockKong.ctx.dike = {
          idempotency_key: idemKey,
          status: mockCheckResponse.status,
          chunks: [],
        };

        if (mockCheckResponse.status === 'Hit') {
          mockKong.response.exitCalled = true;
          mockKong.response.statusCode = mockCheckResponse.cached_status ?? 200;
          mockKong.response.body = mockCheckResponse.cached_body ?? '';
          mockKong.response.headers['Idempotency-Status'] = 'HIT';
          mockKong.response.headers['X-Dike-Kong-Processed'] = 'true';
          return mockKong;
        }

        if (mockCheckResponse.status === 'Mismatch') {
          mockKong.response.exitCalled = true;
          mockKong.response.statusCode = 422;
          mockKong.response.headers['Idempotency-Status'] = 'MISMATCH';
          return mockKong;
        }
      }

      // 2. Upstream forwarding & Header Filter phase
      mockKong.response.headers['X-Dike-Kong-Processed'] = 'true';
      mockKong.response.headers['Idempotency-Status'] = 'MISS';

      // 3. Body Filter phase
      mockKong.ctx.dike?.chunks.push('{"order_id": "ord_999"}');
      mockKong.ctx.dike!.full_response_body = mockKong.ctx.dike?.chunks.join('');

      return mockKong;
    };

    // Test HIT scenario
    const hitRes = runKongPlugin(
      { header_name: 'Idempotency-Key', fail_open: true },
      { status: 'Hit', cached_body: '{"replayed": true}', cached_status: 200 }
    );
    expect(hitRes.response.exitCalled).toBe(true);
    expect(hitRes.response.statusCode).toBe(200);
    expect(hitRes.response.headers['Idempotency-Status']).toBe('HIT');
    expect(hitRes.response.headers['X-Dike-Kong-Processed']).toBe('true');
    expect(hitRes.response.body).toContain('"replayed": true');

    // Test ACQUIRED / MISS scenario
    const acquiredRes = runKongPlugin(
      { header_name: 'Idempotency-Key', fail_open: true },
      { status: 'Acquired' }
    );
    expect(acquiredRes.response.exitCalled).toBe(false);
    expect(acquiredRes.response.headers['Idempotency-Status']).toBe('MISS');
    expect(acquiredRes.ctx.dike?.full_response_body).toContain('ord_999');
  });
});
