import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { StreamingHasher, computeStaticFingerprint } from '../../src/core/hasher.js';

describe('StreamingHasher & Fingerprint Engine', () => {
  it('computes deterministic static fingerprint for identical payload', () => {
    const hash1 = computeStaticFingerprint('POST', '/api/v1/checkout', { amount: 1500, currency: 'USD' });
    const hash2 = computeStaticFingerprint('POST', '/api/v1/checkout', { amount: 1500, currency: 'USD' });
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('differentiates distinct HTTP methods or paths', () => {
    const postHash = computeStaticFingerprint('POST', '/api/v1/checkout', { amount: 1500 });
    const putHash = computeStaticFingerprint('PUT', '/api/v1/checkout', { amount: 1500 });
    const diffPathHash = computeStaticFingerprint('POST', '/api/v2/checkout', { amount: 1500 });

    expect(postHash).not.toBe(putHash);
    expect(postHash).not.toBe(diffPathHash);
  });

  it('computes consistent stream digest matching static computation', async () => {
    const payload = JSON.stringify({ item: 'item_99', qty: 3 });
    const staticHash = computeStaticFingerprint('POST', '/v1/items', payload);

    const payloadBuffer = Buffer.from(payload);
    const chunk1 = payloadBuffer.subarray(0, 10);
    const chunk2 = payloadBuffer.subarray(10, 20);
    const chunk3 = payloadBuffer.subarray(20);

    const stream = Readable.from([chunk1, chunk2, chunk3]);

    const hasher = new StreamingHasher({ method: 'POST', path: '/v1/items' });
    stream.pipe(hasher);

    await new Promise<void>((resolve, reject) => {
      hasher.on('finish', () => resolve());
      hasher.on('error', reject);
      hasher.resume(); // consume output stream
    });

    expect(hasher.getDigest()).toBe(staticHash);
  });

  it('handles empty stream gracefully', async () => {
    const stream = Readable.from([]);
    const hasher = new StreamingHasher({ method: 'GET', path: '/healthz' });
    stream.pipe(hasher);

    await new Promise<void>((resolve, reject) => {
      hasher.on('finish', () => resolve());
      hasher.on('error', reject);
      hasher.resume();
    });

    expect(hasher.getDigest()).toHaveLength(64);
  });
});
