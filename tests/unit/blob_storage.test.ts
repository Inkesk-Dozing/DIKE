/**
 * Test Suite: Ephemeral MinIO / S3 Storage Adapter for Large Payloads (Issue #57)
 * Validates:
 * - Payload size threshold evaluation (default: 1MB).
 * - Offloading payloads > 1MB to S3/MinIO bucket.
 * - Storing S3 URI pointer in storage tier instead of heavy JSONB payload.
 * - Transparent retrieval and reconstruction of original payload on cache hit.
 * - Deletion of blobs upon key cleanup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  S3BlobStorageAdapter,
  InMemoryBlobClient,
  DEFAULT_BLOB_THRESHOLD_BYTES,
} from '../../src/storage/blob_storage.js';
import { executeIdempotentMutation } from '../../src/core/orchestrator.js';
import { ConnectionParkingLot } from '../../src/core/parking.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';

describe('S3BlobStorageAdapter Unit Tests', () => {
  let blobClient: InMemoryBlobClient;
  let adapter: S3BlobStorageAdapter;

  beforeEach(() => {
    blobClient = new InMemoryBlobClient();
    adapter = new S3BlobStorageAdapter({
      bucket: 'dike-payloads',
      blobThresholdBytes: 1024, // 1 KB threshold for test speed
      client: blobClient,
    });
  });

  it('correctly evaluates threshold for small vs large payloads', () => {
    const smallText = 'hello world';
    const largeText = 'A'.repeat(2048); // 2 KB > 1 KB threshold

    expect(adapter.exceedsThreshold(smallText)).toBe(false);
    expect(adapter.exceedsThreshold(largeText)).toBe(true);

    const smallObj = { key: 'val' };
    const largeObj = { data: 'X'.repeat(2000) };

    expect(adapter.exceedsThreshold(smallObj)).toBe(false);
    expect(adapter.exceedsThreshold(largeObj)).toBe(true);
  });

  it('keeps small payloads inline without contacting object storage', async () => {
    const smallPayload = { account: '12345', balance: 50 };
    const res = await adapter.storeIfLarge('tenant_1', 'key_small', smallPayload);

    expect(res.offloaded).toBe(false);
    if (!res.offloaded) {
      expect(res.body).toEqual(smallPayload);
    }
  });

  it('offloads large payloads to S3 bucket and returns s3:// URI pointer', async () => {
    const largeData = {
      invoiceId: 'inv_9999',
      pdfBase64: 'B'.repeat(5000),
    };

    const res = await adapter.storeIfLarge('tenant_corp', 'tx_big_invoice', largeData);

    expect(res.offloaded).toBe(true);
    if (res.offloaded) {
      expect(res.s3Uri).toMatch(/^s3:\/\/dike-payloads\/tenant_corp\/tx_big_invoice-\d+\.bin$/);
      expect(res.metadata.sizeBytes).toBeGreaterThan(5000);

      // Verify object exists in bucket
      const storedBuffer = await blobClient.getObject(res.metadata.bucket, res.metadata.key);
      expect(JSON.parse(storedBuffer.toString('utf-8'))).toEqual(largeData);

      // Verify retrieval and reconstruction
      const reconstructed = await adapter.retrieveIfOffloaded(res.s3Uri);
      expect(reconstructed).toEqual(largeData);
    }
  });

  it('deletes blob from object store', async () => {
    const largeText = 'Z'.repeat(3000);
    const storeRes = await adapter.storeIfLarge('t1', 'k1', largeText);

    expect(storeRes.offloaded).toBe(true);
    if (storeRes.offloaded) {
      await adapter.deleteBlob(storeRes.s3Uri);
      await expect(adapter.retrieveIfOffloaded(storeRes.s3Uri)).rejects.toThrow('NoSuchKey');
    }
  });

  it('parses S3 URI correctly and rejects invalid formats', () => {
    const parsed = adapter.parseS3Uri('s3://my-bucket/path/to/object.bin');
    expect(parsed.bucket).toBe('my-bucket');
    expect(parsed.key).toBe('path/to/object.bin');

    expect(() => adapter.parseS3Uri('http://my-bucket/key')).toThrow('Invalid S3 URI');
    expect(() => adapter.parseS3Uri('s3://my-bucket')).toThrow('missing object key');
  });

  it('defaults threshold to 1MB', () => {
    const defaultAdapter = new S3BlobStorageAdapter();
    expect(defaultAdapter.getThresholdBytes()).toBe(DEFAULT_BLOB_THRESHOLD_BYTES);
    expect(defaultAdapter.getBucket()).toBe('dike-payloads');
  });
});

describe('Orchestrator End-to-End Blob Offloading Integration', () => {
  let storage: MemoryStorageAdapter;
  let parkingLot: ConnectionParkingLot;
  let blobClient: InMemoryBlobClient;
  let blobStorage: S3BlobStorageAdapter;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    parkingLot = new ConnectionParkingLot();
    blobClient = new InMemoryBlobClient();
    blobStorage = new S3BlobStorageAdapter({
      blobThresholdBytes: 500, // 500 bytes threshold
      client: blobClient,
    });
  });

  it('orchestrator stores S3 URI reference in storage and transparently reconstructs body on cache HIT', async () => {
    const mutationKey = 'idem-large-file-upload';
    const largeResult = {
      reportId: 'rep_123',
      content: 'C'.repeat(2000), // 2KB > 500B
    };

    // 1. Initial Leader Execution (MISS)
    const exec1 = await executeIdempotentMutation({
      tenantId: 'tenant_enterprise',
      key: mutationKey,
      storage,
      parkingLot,
      blobStorage,
      action: async () => ({
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: largeResult,
      }),
    });

    expect(exec1.statusCode).toBe(201);
    expect(exec1.idempotencyStatus).toBe('MISS');
    expect(exec1.body).toEqual(largeResult);

    // Verify storage tier contains S3 pointer, NOT raw bulky payload
    const rawRecord = await storage.get('tenant_enterprise', mutationKey);
    expect(rawRecord).toBeDefined();
    expect((rawRecord?.responseBody as any).s3Uri).toBeDefined();
    expect((rawRecord?.responseBody as any).s3Uri).toContain('s3://dike-payloads');

    // 2. Follower / Replay Execution (HIT)
    const exec2 = await executeIdempotentMutation({
      tenantId: 'tenant_enterprise',
      key: mutationKey,
      storage,
      parkingLot,
      blobStorage,
      action: async () => {
        throw new Error('Should not run on replay');
      },
    });

    expect(exec2.statusCode).toBe(201);
    expect(exec2.idempotencyStatus).toBe('HIT');
    // Body is transparently fetched and reconstructed from S3!
    expect(exec2.body).toEqual(largeResult);
  });
});
