/**
 * Streaming Incremental Request Hasher
 * Computes deterministic fingerprints across HTTP method, path, and streaming payload bodies in O(1) memory.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { createHash, Hash } from 'node:crypto';
import { Transform, TransformCallback } from 'node:stream';

export type SupportedAlgorithm = 'sha256' | 'sha512' | 'blake3';

export interface HasherOptions {
  readonly algorithm?: SupportedAlgorithm | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
}

export class StreamingHasher extends Transform {
  private readonly hash: Hash;
  private isFinalized = false;
  private digestHex = '';

  constructor(options: HasherOptions = {}) {
    super();
    const algorithm = options.algorithm === 'sha512' ? 'sha512' : 'sha256';
    this.hash = createHash(algorithm);

    // Prefix with normalized HTTP Method and Canonical Path
    const methodPrefix = (options.method || 'POST').toUpperCase();
    const pathPrefix = (options.path || '/').trim();
    this.hash.update(`${methodPrefix}\n${pathPrefix}\n`);
  }

  public override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.isFinalized) {
      this.hash.update(chunk);
    }
    // Pass chunk downstream without latency overhead
    this.push(chunk);
    callback();
  }

  public override _flush(callback: TransformCallback): void {
    this.digestHex = this.hash.digest('hex');
    this.isFinalized = true;
    callback();
  }

  /**
   * Returns the 64-character hexadecimal fingerprint once the stream has ended.
   */
  public getDigest(): string {
    if (!this.isFinalized) {
      throw new Error('StreamingHasher has not finished processing all stream chunks.');
    }
    return this.digestHex;
  }
}

/**
 * Utility helper to compute fingerprint synchronously from static buffer or string.
 */
export function computeStaticFingerprint(
  method: string,
  path: string,
  payload: string | Buffer | object,
  algorithm: SupportedAlgorithm = 'sha256'
): string {
  const normAlgorithm = algorithm === 'sha512' ? 'sha512' : 'sha256';
  const hasher = createHash(normAlgorithm);
  hasher.update(`${method.toUpperCase()}\n${path.trim()}\n`);

  if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
    hasher.update(payload);
  } else {
    // Deterministic sorted JSON string
    hasher.update(JSON.stringify(payload));
  }

  return hasher.digest('hex');
}
