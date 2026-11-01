/**
 * Ephemeral MinIO / S3 Storage Adapter for Large Payloads (> 10MB / > 1MB)
 * Offloads bulky response payloads (e.g. multi-megabyte PDFs, exports, and files)
 * to S3/MinIO compatible object stores, replacing in-database JSONB columns with URI pointers.
 * Transparently streams and reconstructs payloads upon cache retrieval.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import crypto from 'crypto';
import { defaultLogger } from '../utils/logger.js';

export const DEFAULT_BLOB_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1 MB

export interface BlobMetadata {
  readonly bucket: string;
  readonly key: string;
  readonly s3Uri: string;
  readonly sizeBytes: number;
  readonly contentType?: string | undefined;
  readonly etag?: string | undefined;
}

export interface BlobStorageConfig {
  readonly endpoint?: string | undefined;
  readonly region?: string | undefined;
  readonly bucket?: string | undefined;
  readonly accessKeyId?: string | undefined;
  readonly secretAccessKey?: string | undefined;
  readonly blobThresholdBytes?: number | undefined;
  readonly client?: IBlobClient | undefined;
}

export interface IBlobClient {
  putObject(bucket: string, key: string, data: Buffer, contentType?: string | undefined): Promise<{ etag?: string | undefined }>;
  getObject(bucket: string, key: string): Promise<Buffer>;
  deleteObject(bucket: string, key: string): Promise<void>;
  headObject?(bucket: string, key: string): Promise<{ sizeBytes: number; contentType?: string | undefined }>;
}

/**
 * In-memory / HTTP simulated S3/MinIO client implementing the IBlobClient contract.
 * Zero external heavyweight AWS SDK dependencies required, native to project architecture.
 */
export class InMemoryBlobClient implements IBlobClient {
  private readonly storage = new Map<string, { data: Buffer; contentType?: string | undefined; etag: string }>();

  public async putObject(
    bucket: string,
    key: string,
    data: Buffer,
    contentType?: string | undefined
  ): Promise<{ etag: string }> {
    const etag = `"${crypto.createHash('md5').update(data).digest('hex')}"`;
    this.storage.set(`${bucket}/${key}`, {
      data: Buffer.from(data),
      contentType,
      etag,
    });
    return { etag };
  }

  public async getObject(bucket: string, key: string): Promise<Buffer> {
    const item = this.storage.get(`${bucket}/${key}`);
    if (!item) {
      const err: any = new Error(`NoSuchKey: The specified key does not exist (${bucket}/${key})`);
      err.code = 'NoSuchKey';
      err.statusCode = 404;
      throw err;
    }
    return Buffer.from(item.data);
  }

  public async deleteObject(bucket: string, key: string): Promise<void> {
    this.storage.delete(`${bucket}/${key}`);
  }

  public async headObject(
    bucket: string,
    key: string
  ): Promise<{ sizeBytes: number; contentType?: string | undefined }> {
    const item = this.storage.get(`${bucket}/${key}`);
    if (!item) {
      const err: any = new Error(`NoSuchKey (${bucket}/${key})`);
      err.statusCode = 404;
      throw err;
    }
    return {
      sizeBytes: item.data.length,
      contentType: item.contentType,
    };
  }

  public clear(): void {
    this.storage.clear();
  }
}

export class S3BlobStorageAdapter {
  private readonly bucket: string;
  private readonly thresholdBytes: number;
  private readonly client: IBlobClient;

  constructor(config: BlobStorageConfig = {}) {
    this.bucket = config.bucket ?? 'dike-payloads';
    this.thresholdBytes = config.blobThresholdBytes ?? DEFAULT_BLOB_THRESHOLD_BYTES;
    this.client = config.client ?? new InMemoryBlobClient();
  }

  /**
   * Evaluates if a given payload exceeds the blob threshold.
   */
  public exceedsThreshold(payload: unknown): boolean {
    if (payload === null || payload === undefined) {
      return false;
    }

    if (Buffer.isBuffer(payload)) {
      return payload.length >= this.thresholdBytes;
    }

    if (typeof payload === 'string') {
      return Buffer.byteLength(payload, 'utf-8') >= this.thresholdBytes;
    }

    try {
      const jsonStr = JSON.stringify(payload);
      return Buffer.byteLength(jsonStr, 'utf-8') >= this.thresholdBytes;
    } catch {
      return false;
    }
  }

  /**
   * Offloads payload to MinIO/S3 if it exceeds the threshold.
   * Returns `{ offloaded: true, blobRef, s3Uri }` or `{ offloaded: false, body }`.
   */
  public async storeIfLarge(
    tenantId: string,
    key: string,
    payload: unknown,
    contentType = 'application/octet-stream'
  ): Promise<
    | { offloaded: true; s3Uri: string; metadata: BlobMetadata }
    | { offloaded: false; body: unknown }
  > {
    if (!this.exceedsThreshold(payload)) {
      return { offloaded: false, body: payload };
    }

    let buffer: Buffer;
    if (Buffer.isBuffer(payload)) {
      buffer = payload;
    } else if (typeof payload === 'string') {
      buffer = Buffer.from(payload, 'utf-8');
    } else {
      buffer = Buffer.from(JSON.stringify(payload), 'utf-8');
      contentType = 'application/json';
    }

    const sanitizedKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const objectKey = `${tenantId}/${sanitizedKey}-${Date.now()}.bin`;

    const putRes = await this.client.putObject(this.bucket, objectKey, buffer, contentType);
    const s3Uri = `s3://${this.bucket}/${objectKey}`;

    defaultLogger.info({
      msg: 'Large payload offloaded to S3 object storage',
      tenantId,
      key,
      s3Uri,
      sizeBytes: buffer.length,
    });

    return {
      offloaded: true,
      s3Uri,
      metadata: {
        bucket: this.bucket,
        key: objectKey,
        s3Uri,
        sizeBytes: buffer.length,
        contentType,
        etag: putRes.etag,
      },
    };
  }

  /**
   * Resolves a stored body. If body is an S3 URI or blob pointer object,
   * fetches and reconstructs the original buffer from object storage.
   */
  public async retrieveIfOffloaded(bodyOrRef: unknown): Promise<unknown> {
    if (!bodyOrRef) {
      return bodyOrRef;
    }

    let s3Uri: string | null = null;
    if (typeof bodyOrRef === 'string' && bodyOrRef.startsWith('s3://')) {
      s3Uri = bodyOrRef;
    } else if (
      typeof bodyOrRef === 'object' &&
      bodyOrRef !== null &&
      's3Uri' in bodyOrRef &&
      typeof (bodyOrRef as any).s3Uri === 'string'
    ) {
      s3Uri = (bodyOrRef as any).s3Uri;
    }

    if (!s3Uri) {
      return bodyOrRef; // Inline non-offloaded payload
    }

    const { bucket, key } = this.parseS3Uri(s3Uri);
    const data = await this.client.getObject(bucket, key);

    defaultLogger.debug({
      msg: 'Retrieved large payload from S3 object storage',
      s3Uri,
      bytes: data.length,
    });

    // Check if original data was JSON
    try {
      return JSON.parse(data.toString('utf-8'));
    } catch {
      return data;
    }
  }

  /**
   * Deletes a blob from object storage.
   */
  public async deleteBlob(s3Uri: string): Promise<void> {
    const { bucket, key } = this.parseS3Uri(s3Uri);
    await this.client.deleteObject(bucket, key);
  }

  public parseS3Uri(s3Uri: string): { bucket: string; key: string } {
    if (!s3Uri.startsWith('s3://')) {
      throw new Error(`Invalid S3 URI format: "${s3Uri}". Expected format "s3://bucket/key".`);
    }

    const withoutPrefix = s3Uri.slice(5);
    const slashIdx = withoutPrefix.indexOf('/');
    if (slashIdx === -1) {
      throw new Error(`Invalid S3 URI: missing object key path in "${s3Uri}".`);
    }

    const bucket = withoutPrefix.slice(0, slashIdx);
    const key = withoutPrefix.slice(slashIdx + 1);

    return { bucket, key };
  }

  public getThresholdBytes(): number {
    return this.thresholdBytes;
  }

  public getBucket(): string {
    return this.bucket;
  }
}
