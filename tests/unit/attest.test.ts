/**
 * Test Suite: Cryptographic HMAC-SHA256 & Ed25519 Attestation Receipt Signer (Issue #53)
 * Validates canonical serialization, HMAC-SHA256 signatures, Ed25519 asymmetric signatures,
 * constant-time verification, tampering detection, and reverse proxy header injection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import fastify, { FastifyInstance } from 'fastify';
import {
  AttestationReceiptSigner,
  ATTESTATION_HEADER_NAME,
} from '../../src/security/attest.js';
import { transparentReverseProxy } from '../../src/proxy/handler.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { IETF_IDEMPOTENCY_KEY_HEADER } from '../../src/server/plugins/ietf_headers.js';

describe('AttestationReceiptSigner Unit Tests', () => {
  const hmacSecret = 'super_secure_secret_key_for_dike_attestation_hmac_sha256_32bytes';

  it('generates canonical format string deterministically', () => {
    const signer = new AttestationReceiptSigner({ secretKey: hmacSecret });
    const canonical = signer.canonicalize({
      tenantId: 'tenant_fin',
      key: 'key_12345',
      fingerprint: 'fp_abc987',
      statusCode: 201,
      timestamp: 1700000000000,
    });

    expect(canonical).toBe('tenant_fin|key_12345|fp_abc987|201|1700000000000');
  });

  describe('HMAC-SHA256 Signing & Verification', () => {
    it('signs and successfully verifies valid HMAC-SHA256 receipt in constant time', () => {
      const signer = new AttestationReceiptSigner({
        algorithm: 'hmac-sha256',
        secretKey: hmacSecret,
        keyId: 'v1',
      });

      const payload = {
        tenantId: 'tenant_fin',
        key: 'key_abc',
        fingerprint: 'fp_xyz',
        statusCode: 200,
        timestamp: 1700000000000,
      };

      const receipt = signer.sign(payload);
      expect(receipt.algorithm).toBe('hmac-sha256');
      expect(receipt.version).toBe('v1');
      expect(receipt.signature).toHaveLength(64); // 32 bytes hex = 64 characters
      expect(receipt.headerValue).toContain('v1;alg=hmac-sha256;sig=');

      const isValid = signer.verify(payload, receipt);
      expect(isValid).toBe(true);

      const isValidFromHeader = signer.verify(payload, receipt.headerValue);
      expect(isValidFromHeader).toBe(true);
    });

    it('rejects tampered payload fields or modified signatures', () => {
      const signer = new AttestationReceiptSigner({
        algorithm: 'hmac-sha256',
        secretKey: hmacSecret,
      });

      const payload = {
        tenantId: 'tenant_fin',
        key: 'key_abc',
        fingerprint: 'fp_xyz',
        statusCode: 200,
        timestamp: 1700000000000,
      };

      const receipt = signer.sign(payload);

      // Tampered status code
      expect(signer.verify({ ...payload, statusCode: 500 }, receipt)).toBe(false);
      // Tampered fingerprint
      expect(signer.verify({ ...payload, fingerprint: 'fp_tampered' }, receipt)).toBe(false);
      // Tampered key
      expect(signer.verify({ ...payload, key: 'key_tampered' }, receipt)).toBe(false);
      // Tampered tenant
      expect(signer.verify({ ...payload, tenantId: 'tenant_evil' }, receipt)).toBe(false);

      // Tampered signature in header
      const tamperedHeader = receipt.headerValue.replace('sig=', 'sig=0000');
      expect(signer.verify(payload, tamperedHeader)).toBe(false);
    });
  });

  describe('Ed25519 Asymmetric Signing & Verification', () => {
    let edKeyPair: crypto.KeyPairSyncResult<string, string>;

    beforeEach(() => {
      edKeyPair = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
    });

    it('signs with Ed25519 private key and verifies with public key', () => {
      const signer = new AttestationReceiptSigner({
        algorithm: 'ed25519',
        secretKey: edKeyPair.privateKey,
        publicKey: edKeyPair.publicKey,
        keyId: 'ed-v1',
      });

      const payload = {
        tenantId: 'tenant_crypto',
        key: 'tx_ledger_777',
        fingerprint: 'fp_ed25519',
        statusCode: 200,
        timestamp: 1711111111111,
      };

      const receipt = signer.sign(payload);
      expect(receipt.algorithm).toBe('ed25519');
      expect(receipt.signature).toHaveLength(128); // 64 bytes hex = 128 chars

      const isValid = signer.verify(payload, receipt);
      expect(isValid).toBe(true);

      // Tampered verification fails
      expect(signer.verify({ ...payload, statusCode: 404 }, receipt)).toBe(false);
    });
  });
});

describe('Attestation Integration with Transparent Reverse Proxy', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let proxyApp: FastifyInstance;
  let storage: MemoryStorageAdapter;
  const hmacSecret = 'super_secret_proxy_attestation_key_32bytes_min';

  beforeEach(async () => {
    upstreamServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'settled', amount: 500 }));
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        const addr = upstreamServer.address() as any;
        upstreamPort = addr.port;
        resolve();
      });
    });

    storage = new MemoryStorageAdapter();
  });

  afterEach(async () => {
    if (proxyApp) {
      await proxyApp.close();
    }
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it('does NOT attach attestation header on fresh execution (MISS), but attaches it on replay (HIT)', async () => {
    const attestationSigner = new AttestationReceiptSigner({
      secretKey: hmacSecret,
    });

    proxyApp = fastify({ logger: false });
    await proxyApp.register(transparentReverseProxy, {
      upstream: { targetUrl: `http://127.0.0.1:${upstreamPort}` },
      storage,
      attestationSigner,
    });
    await proxyApp.ready();

    const mutationKey = 'idem-attest-test-42';

    // Call 1: MISS (Fresh execution)
    const res1 = await proxyApp.inject({
      method: 'POST',
      url: '/payments',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: mutationKey,
        'content-type': 'application/json',
      },
      payload: { amount: 500 },
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.headers[ATTESTATION_HEADER_NAME]).toBeUndefined(); // No attestation on fresh call

    // Call 2: HIT (Replay)
    const res2 = await proxyApp.inject({
      method: 'POST',
      url: '/payments',
      headers: {
        [IETF_IDEMPOTENCY_KEY_HEADER]: mutationKey,
        'content-type': 'application/json',
      },
      payload: { amount: 500 },
    });

    expect(res2.statusCode).toBe(200);
    const attestHeader = res2.headers[ATTESTATION_HEADER_NAME];
    expect(attestHeader).toBeDefined();
    expect(String(attestHeader)).toContain('alg=hmac-sha256;sig=');

    // Verify mathematical proof using the signer
    const isValid = attestationSigner.verify(
      {
        tenantId: 'default_tenant',
        key: mutationKey,
        fingerprint: '',
        statusCode: 200,
        timestamp: 0, // extracted from header
      },
      String(attestHeader)
    );
    expect(isValid).toBe(true);
  });
});
