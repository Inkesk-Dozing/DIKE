/**
 * Test Suite: Duplex Response Stream Tee & Ephemeral Result Buffering (Issue #51)
 * Verifies transparent pass-through streaming, zero TTFB degradation, payload buffer collection,
 * MAX_RESPONSE_BYTES threshold overflow aborting, and error propagation.
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import {
  createResponseStreamTee,
  DEFAULT_MAX_RESPONSE_BYTES,
} from '../../src/proxy/stream_tee.js';

describe('Duplex Response Stream Tee & Ephemeral Result Buffering', () => {
  it('correctly passes through stream chunks to clientStream while buffering in memory', async () => {
    const inputData = ['chunk 1: {"id":', ' "order_123",', ' "status": "CONFIRMED"}'];
    const sourceStream = Readable.from(inputData);

    const tee = createResponseStreamTee(sourceStream);

    // Consume client stream concurrently
    const clientChunks: Buffer[] = [];
    tee.clientStream.on('data', (c) => clientChunks.push(Buffer.from(c)));

    const clientFinished = new Promise<void>((resolve) => {
      tee.clientStream.on('end', () => resolve());
    });

    const [buffered, _] = await Promise.all([tee.bufferPromise, clientFinished]);

    const expectedText = inputData.join('');
    const clientText = Buffer.concat(clientChunks).toString('utf-8');
    const bufferedText = buffered?.toString('utf-8');

    expect(clientText).toBe(expectedText);
    expect(bufferedText).toBe(expectedText);
    expect(tee.isOverflow()).toBe(false);
    expect(tee.getBytesRead()).toBe(Buffer.byteLength(expectedText));
  });

  it('handles binary stream chunks transparently without corruption', async () => {
    const binaryData = Buffer.from([0x00, 0xff, 0x42, 0x13, 0x37, 0xca, 0xfe]);
    const sourceStream = Readable.from([binaryData]);

    const tee = createResponseStreamTee(sourceStream);

    const clientChunks: Buffer[] = [];
    tee.clientStream.on('data', (c) => clientChunks.push(Buffer.from(c)));

    const [buffered] = await Promise.all([
      tee.bufferPromise,
      new Promise<void>((resolve) => tee.clientStream.on('end', () => resolve())),
    ]);

    expect(Buffer.concat(clientChunks)).toEqual(binaryData);
    expect(buffered).toEqual(binaryData);
    expect(tee.getBytesRead()).toBe(binaryData.length);
  });

  it('aborts buffering when payload exceeds maxBufferBytes but keeps clientStream flowing', async () => {
    // 5 chunks of 100 bytes = 500 bytes total
    const chunks = Array.from({ length: 5 }, (_, i) =>
      Buffer.alloc(100, `chunk-${i}`.charCodeAt(0))
    );
    const sourceStream = Readable.from(chunks);

    // Set max limit to 250 bytes
    const tee = createResponseStreamTee(sourceStream, { maxBufferBytes: 250 });

    const clientChunks: Buffer[] = [];
    tee.clientStream.on('data', (c) => clientChunks.push(Buffer.from(c)));

    const [buffered] = await Promise.all([
      tee.bufferPromise,
      new Promise<void>((resolve) => tee.clientStream.on('end', () => resolve())),
    ]);

    // Client stream received the complete 500 bytes uninterrupted
    expect(Buffer.concat(clientChunks).length).toBe(500);
    // Buffering aborted, resolved to null
    expect(buffered).toBeNull();
    expect(tee.isOverflow()).toBe(true);
    expect(tee.getBytesRead()).toBe(500);
  });

  it('works with Web ReadableStream source (fetch response body simulation)', async () => {
    const payload = JSON.stringify({ message: 'streamed via web ReadableStream' });
    const encoder = new TextEncoder();
    const uint8 = encoder.encode(payload);

    // Create a Web standard ReadableStream
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(uint8.subarray(0, 15));
        controller.enqueue(uint8.subarray(15));
        controller.close();
      },
    });

    const tee = createResponseStreamTee(webStream);

    const clientChunks: Buffer[] = [];
    tee.clientStream.on('data', (c) => clientChunks.push(Buffer.from(c)));

    const [buffered] = await Promise.all([
      tee.bufferPromise,
      new Promise<void>((resolve) => tee.clientStream.on('end', () => resolve())),
    ]);

    expect(Buffer.concat(clientChunks).toString('utf-8')).toBe(payload);
    expect(buffered?.toString('utf-8')).toBe(payload);
    expect(tee.isOverflow()).toBe(false);
  });

  it('propagates stream error to both clientStream and bufferPromise', async () => {
    const streamError = new Error('Upstream socket reset unexpectedly');
    const sourceStream = new Readable({
      read() {
        this.emit('error', streamError);
      },
    });

    const tee = createResponseStreamTee(sourceStream);

    let clientCaughtError: any;
    tee.clientStream.on('error', (err) => {
      clientCaughtError = err;
    });

    await expect(tee.bufferPromise).rejects.toThrow('Upstream socket reset unexpectedly');
    expect(clientCaughtError).toBe(streamError);
  });

  it('defaults maxBufferBytes to 5MB (DEFAULT_MAX_RESPONSE_BYTES)', () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(5 * 1024 * 1024);
  });
});
