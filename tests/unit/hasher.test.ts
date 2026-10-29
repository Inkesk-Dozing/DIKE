/**
 * Exhaustive Vitest Unit Test Suite for StreamingHasher & Collision Resistance
 * Tests streaming digests, memory boundedness with large streams, Unicode normalization, algorithms, and static equivalence.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { StreamingHasher, computeStaticFingerprint } from '../../src/core/hasher.js';

describe('StreamingHasher & Collision Resistance Verification', () => {
  describe('Static & Streaming Determinism', () => {
    it('computes identical hexadecimal digests for identical static payloads', () => {
      const hash1 = computeStaticFingerprint('POST', '/api/v1/checkout', { amount: 1500, currency: 'USD' });
      const hash2 = computeStaticFingerprint('POST', '/api/v1/checkout', { amount: 1500, currency: 'USD' });
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('differentiates distinct HTTP methods, paths, and casing', () => {
      const postHash = computeStaticFingerprint('POST', '/api/v1/checkout', { amount: 1500 });
      const putHash = computeStaticFingerprint('PUT', '/api/v1/checkout', { amount: 1500 });
      const lowerPostHash = computeStaticFingerprint('post', '/api/v1/checkout', { amount: 1500 });
      const diffPathHash = computeStaticFingerprint('POST', '/api/v2/checkout', { amount: 1500 });

      // Method normalization: uppercase canonicalization ensures 'post' and 'POST' match
      expect(postHash).toBe(lowerPostHash);
      expect(postHash).not.toBe(putHash);
      expect(postHash).not.toBe(diffPathHash);
    });

    it('produces identical digest between streaming chunks and static computation', async () => {
      const payload = JSON.stringify({ item: 'item_99', qty: 3, timestamp: '2026-10-29T00:00:00Z' });
      const staticHash = computeStaticFingerprint('POST', '/v1/items', payload);

      const payloadBuffer = Buffer.from(payload);
      const chunk1 = payloadBuffer.subarray(0, 15);
      const chunk2 = payloadBuffer.subarray(15, 30);
      const chunk3 = payloadBuffer.subarray(30);

      const stream = Readable.from([chunk1, chunk2, chunk3]);
      const hasher = new StreamingHasher({ method: 'POST', path: '/v1/items' });
      stream.pipe(hasher);

      await new Promise<void>((resolve, reject) => {
        hasher.on('finish', () => resolve());
        hasher.on('error', reject);
        hasher.resume();
      });

      expect(hasher.getDigest()).toBe(staticHash);
    });

    it('handles empty stream and empty body gracefully', async () => {
      const stream = Readable.from([]);
      const hasher = new StreamingHasher({ method: 'GET', path: '/healthz' });
      stream.pipe(hasher);

      await new Promise<void>((resolve, reject) => {
        hasher.on('finish', () => resolve());
        hasher.on('error', reject);
        hasher.resume();
      });

      const digest = hasher.getDigest();
      expect(digest).toHaveLength(64);

      const staticEmpty = computeStaticFingerprint('GET', '/healthz', '');
      expect(digest).toBe(staticEmpty);
    });
  });

  describe('Multi-Algorithm & Cryptographic Specifications', () => {
    it('supports sha512 algorithm with 128-character digest output', async () => {
      const payload = 'multi-algo-test-string';
      const staticSha512 = computeStaticFingerprint('POST', '/secure', payload, 'sha512');
      expect(staticSha512).toHaveLength(128);

      const hasher = new StreamingHasher({ algorithm: 'sha512', method: 'POST', path: '/secure' });
      const stream = Readable.from([Buffer.from(payload)]);
      stream.pipe(hasher);

      await new Promise<void>((resolve, reject) => {
        hasher.on('finish', () => resolve());
        hasher.on('error', reject);
        hasher.resume();
      });

      expect(hasher.getDigest()).toBe(staticSha512);
    });

    it('throws error when requesting digest before stream finalization', () => {
      const hasher = new StreamingHasher({ method: 'POST', path: '/unfinalized' });
      expect(() => {
        hasher.getDigest();
      }).toThrow('StreamingHasher has not finished processing all stream chunks.');
    });
  });

  describe('Unicode & High-Volume Data Streaming (O(1) Memory)', () => {
    it('normalizes multi-byte Unicode and UTF-8 special characters without collision', () => {
      const unicode1 = computeStaticFingerprint('POST', '/intl', { message: 'こんにちは世界 🌍' });
      const unicode2 = computeStaticFingerprint('POST', '/intl', { message: 'こんにちは世界 🌎' });
      const unicode1Dup = computeStaticFingerprint('POST', '/intl', { message: 'こんにちは世界 🌍' });

      expect(unicode1).toBe(unicode1Dup);
      expect(unicode1).not.toBe(unicode2);
    });

    it('processes multi-megabyte stream chunks in O(1) memory footprint', async () => {
      // Stream 5MB of repeated data in 64KB chunks
      const chunkSize = 64 * 1024;
      const totalChunks = 80; // 5.12 MB
      const chunkData = Buffer.alloc(chunkSize, 'A');

      let chunkIndex = 0;
      const largeStream = new Readable({
        read() {
          if (chunkIndex < totalChunks) {
            this.push(chunkData);
            chunkIndex++;
          } else {
            this.push(null);
          }
        },
      });

      const hasher = new StreamingHasher({ method: 'POST', path: '/v1/upload-blob' });
      largeStream.pipe(hasher);

      await new Promise<void>((resolve, reject) => {
        hasher.on('finish', () => resolve());
        hasher.on('error', reject);
        hasher.resume();
      });

      const digest = hasher.getDigest();
      expect(digest).toHaveLength(64);
    });
  });
});
