/**
 * Test Suite: Public Verification Endpoint & Receipt Validator (Issue #54)
 * Validates POST /v1/attest/verify for schema enforcement, authentic receipt confirmation,
 * payload tampering rejection, and unconfigured service handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { AttestationReceiptSigner } from '../../src/security/attest.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';

describe('POST /v1/attest/verify API Route', () => {
  let app: FastifyInstance;
  let signer: AttestationReceiptSigner;
  const hmacSecret = 'test_secret_for_standalone_attestation_verify_endpoint_32bytes';

  beforeEach(async () => {
    signer = new AttestationReceiptSigner({
      secretKey: hmacSecret,
      algorithm: 'hmac-sha256',
    });

    app = await buildApp({
      storage: new MemoryStorageAdapter(),
      attestationSigner: signer,
      config: { LOG_LEVEL: 'silent' },
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('rejects malformed payloads with HTTP 400 Bad Request', async () => {
    // Missing body
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      headers: { 'content-type': 'application/json' },
    });
    expect(res1.statusCode).toBe(400);

    // Missing idempotencyKey
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      payload: {
        fingerprint: 'fp_123',
        statusCode: 200,
        attestationHeader: 'v1;alg=hmac-sha256;sig=abc;ts=123',
      },
    });
    expect(res2.statusCode).toBe(400);
    expect(JSON.parse(res2.body).message).toContain('idempotencyKey');

    // Missing fingerprint
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      payload: {
        idempotencyKey: 'key_123',
        statusCode: 200,
        attestationHeader: 'v1;alg=hmac-sha256;sig=abc;ts=123',
      },
    });
    expect(res3.statusCode).toBe(400);
    expect(JSON.parse(res3.body).message).toContain('fingerprint');

    // Missing statusCode
    const res4 = await app.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      payload: {
        idempotencyKey: 'key_123',
        fingerprint: 'fp_123',
        attestationHeader: 'v1;alg=hmac-sha256;sig=abc;ts=123',
      },
    });
    expect(res4.statusCode).toBe(400);
    expect(JSON.parse(res4.body).message).toContain('statusCode');

    // Missing attestationHeader
    const res5 = await app.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      payload: {
        idempotencyKey: 'key_123',
        fingerprint: 'fp_123',
        statusCode: 200,
      },
    });
    expect(res5.statusCode).toBe(400);
    expect(JSON.parse(res5.body).message).toContain('attestationHeader');
  });

  it('returns valid: true for authentic receipt signatures', async () => {
    const payload = {
      tenantId: 'auditor-client-1',
      key: 'tx-fin-order-888',
      fingerprint: 'sha256:abcd9876ef543210',
      statusCode: 201,
      timestamp: 1710000000000,
    };

    const receipt = signer.sign(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      payload: {
        idempotencyKey: payload.key,
        fingerprint: payload.fingerprint,
        statusCode: payload.statusCode,
        attestationHeader: receipt.headerValue,
        tenantId: payload.tenantId,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.valid).toBe(true);
    expect(body.keyOwner).toBe('auditor-client-1');
    expect(body.statusCode).toBe(201);
    expect(body.issuedAt).toBe(new Date(1710000000000).toISOString());
  });

  it('returns valid: false when payload status code, fingerprint, or signature is tampered', async () => {
    const payload = {
      tenantId: 'default_tenant',
      key: 'tx-fin-order-888',
      fingerprint: 'sha256:abcd9876ef543210',
      statusCode: 200,
      timestamp: 1710000000000,
    };

    const receipt = signer.sign(payload);

    // 1. Tampered Status Code (claiming 200 when 400 was signed)
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      payload: {
        idempotencyKey: payload.key,
        fingerprint: payload.fingerprint,
        statusCode: 400, // tampered!
        attestationHeader: receipt.headerValue,
      },
    });

    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.valid).toBe(false);
    expect(body1.error).toBe('SignatureMismatch');

    // 2. Tampered fingerprint
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      payload: {
        idempotencyKey: payload.key,
        fingerprint: 'sha256:tampered_content_hash',
        statusCode: 200,
        attestationHeader: receipt.headerValue,
      },
    });

    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body).valid).toBe(false);

    // 3. Forged signature in header
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      payload: {
        idempotencyKey: payload.key,
        fingerprint: payload.fingerprint,
        statusCode: 200,
        attestationHeader: receipt.headerValue.replace(/sig=[a-f0-9]+/, 'sig=deadbeef0011223344'),
      },
    });

    expect(res3.statusCode).toBe(200);
    expect(JSON.parse(res3.body).valid).toBe(false);
  });

  it('returns HTTP 503 if verification signer is not configured on the server instance', async () => {
    const unconfiguredApp = await buildApp({
      storage: new MemoryStorageAdapter(),
      attestationSigner: undefined, // omitted
      config: { LOG_LEVEL: 'silent' },
    });
    await unconfiguredApp.ready();

    const res = await unconfiguredApp.inject({
      method: 'POST',
      url: '/v1/attest/verify',
      payload: {
        idempotencyKey: 'key_123',
        fingerprint: 'fp_123',
        statusCode: 200,
        attestationHeader: 'v1;alg=hmac-sha256;sig=abcd;ts=123',
      },
    });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).message).toContain('not configured');

    await unconfiguredApp.close();
  });
});
