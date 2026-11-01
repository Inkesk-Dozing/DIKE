/**
 * Duplex Response Stream Tee & Ephemeral Result Buffering for DIKE
 * Splits an inbound upstream response stream into:
 *   1. Direct PassThrough branch streamed back to the client socket (zero TTFB delay).
 *   2. Ephemeral In-Memory collector branch that accumulates payload chunks up to MAX_RESPONSE_BYTES
 *      to commit to the L1/L2/L3 idempotency storage cache.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { PassThrough, Readable } from 'stream';
import { defaultLogger } from '../utils/logger.js';

export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface StreamTeeOptions {
  /**
   * Maximum response payload size in bytes to buffer.
   * If exceeded, buffering aborts and cache commit is skipped,
   * but the client stream continues uninterrupted.
   * Default: 5MB (5 * 1024 * 1024).
   */
  readonly maxBufferBytes?: number | undefined;
  /**
   * Optional logger instance.
   */
  readonly logger?: typeof defaultLogger | undefined;
}

export interface StreamTeeResult {
  /**
   * The PassThrough readable stream to be piped to the client HTTP response.
   */
  readonly clientStream: PassThrough;
  /**
   * A promise that resolves when the upstream stream finishes.
   * Returns the buffered Buffer if within limits, or null if the payload
   * exceeded maxBufferBytes or suffered an upstream error.
   */
  readonly bufferPromise: Promise<Buffer | null>;
  /**
   * Whether the stream payload exceeded maxBufferBytes.
   */
  readonly isOverflow: () => boolean;
  /**
   * Total bytes received from the upstream response.
   */
  readonly getBytesRead: () => number;
}

/**
 * Creates a duplex stream tee that forwards data transparently to the client
 * while buffering in memory for idempotency caching.
 *
 * @param source Readable stream (Node.js stream or web ReadableStream)
 * @param options StreamTeeOptions
 */
export function createResponseStreamTee(
  source: Readable | NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  options: StreamTeeOptions = {}
): StreamTeeResult {
  const maxBytes = options.maxBufferBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const logger = options.logger ?? defaultLogger;

  const clientStream = new PassThrough();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let overflow = false;

  const bufferPromise = new Promise<Buffer | null>((resolve, reject) => {
    // Helper to convert web ReadableStream to Node.js Readable if needed
    let nodeStream: NodeJS.ReadableStream;

    if (typeof (source as any).getReader === 'function') {
      nodeStream = Readable.fromWeb(source as any);
    } else {
      nodeStream = source as NodeJS.ReadableStream;
    }

    nodeStream.on('data', (chunk: Buffer | Uint8Array | string) => {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

      totalBytes += buf.length;

      // Pipe to client without delay
      clientStream.write(buf);

      // Collect in memory if not overflowed
      if (!overflow) {
        if (totalBytes > maxBytes) {
          overflow = true;
          chunks.length = 0; // free memory immediately
          logger.warn({
            msg: 'Response payload exceeded MAX_RESPONSE_BYTES; buffering aborted',
            totalBytes,
            maxBytes,
          });
        } else {
          chunks.push(buf);
        }
      }
    });

    nodeStream.on('end', () => {
      clientStream.end();
      if (overflow) {
        resolve(null);
      } else {
        const fullBuffer = Buffer.concat(chunks);
        resolve(fullBuffer);
      }
    });

    nodeStream.on('error', (err) => {
      clientStream.destroy(err);
      logger.error({
        msg: 'Error reading upstream response stream',
        err,
      });
      reject(err);
    });
  });

  return {
    clientStream,
    bufferPromise,
    isOverflow: () => overflow,
    getBytesRead: () => totalBytes,
  };
}
