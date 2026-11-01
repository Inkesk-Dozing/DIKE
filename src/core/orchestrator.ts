/**
 * Concurrent Execution Orchestrator & Fastify Gateway Helper
 * Coordinates end-to-end leader-follower mutation execution with connection parking,
 * error classification, large blob object offloading, and lease eviction, ensuring exactly-once execution.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IIdempotencyStorage } from '../storage/interface.js';
import { ConnectionParkingLot, ParkedResponsePayload } from './parking.js';
import { BoundedParkingHandler } from './parking_timeout.js';
import { AdaptiveBackpressureController, defaultBackpressureController } from './backpressure.js';
import { ErrorStatusClassifier, defaultErrorClassifier } from './error_classifier.js';
import { S3BlobStorageAdapter } from '../storage/blob_storage.js';
import { computeStaticFingerprint } from './hasher.js';
import { defaultLogger } from '../utils/logger.js';

export interface ExecuteIdempotentOptions<T = unknown> {
  readonly tenantId: string;
  readonly key: string;
  readonly storage: IIdempotencyStorage;
  readonly parkingLot: ConnectionParkingLot;
  readonly backpressure?: AdaptiveBackpressureController | undefined;
  readonly errorClassifier?: ErrorStatusClassifier | undefined;
  readonly blobStorage?: S3BlobStorageAdapter | undefined;
  readonly ttlMs?: number | undefined;
  readonly lockTimeoutMs?: number | undefined;
  readonly parkingTimeoutMs?: number | undefined;
  readonly requestPayload?: string | Buffer | object | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  /**
   * The actual business logic / upstream mutation to execute exactly once.
   */
  readonly action: () => Promise<{ statusCode: number; headers?: Record<string, string>; body: T }>;
}

export interface IdempotentExecutionResult<T = unknown> {
  readonly role: 'LEADER' | 'FOLLOWER';
  readonly statusCode: number;
  readonly headers?: Record<string, string> | undefined;
  readonly body: T;
  readonly idempotencyStatus: 'HIT' | 'MISS';
}

/**
 * Executes a mutation with guaranteed exactly-once idempotency semantics,
 * leader election via atomic lease acquisition, follower connection parking,
 * blob offloading, error classification, and adaptive backpressure.
 */
export async function executeIdempotentMutation<T = unknown>(
  options: ExecuteIdempotentOptions<T>
): Promise<IdempotentExecutionResult<T>> {
  const {
    tenantId,
    key,
    storage,
    parkingLot,
    backpressure = defaultBackpressureController,
    errorClassifier = defaultErrorClassifier,
    blobStorage,
    ttlMs = 86_400_000,
    lockTimeoutMs = 30_000,
    parkingTimeoutMs = 15_000,
    requestPayload = {},
    method = 'POST',
    path = '/',
    action,
  } = options;

  const payloadToHash = (requestPayload ?? {}) as string | Buffer | object;
  const fingerprint = computeStaticFingerprint(method, path, payloadToHash);

  // 1. Attempt atomic lease acquisition
  const acquireResult = await storage.acquire({
    tenantId,
    key,
    requestFingerprint: fingerprint,
    ttlMs,
    lockTimeoutMs,
  });

  // 2. Case A: ACQUIRED -> Elected as LEADER
  if (acquireResult.status === 'ACQUIRED') {
    const fencingToken = acquireResult.fencingToken;
    try {
      // Execute the upstream mutation
      const actionResult = await action();
      const decision = errorClassifier.classifyStatus(actionResult.statusCode);

      if (decision.isCacheable) {
        // Evaluate if body exceeds blob threshold and needs S3 offloading
        let bodyToPersist: unknown = actionResult.body;
        if (blobStorage) {
          const offloadRes = await blobStorage.storeIfLarge(
            tenantId,
            key,
            actionResult.body,
            actionResult.headers?.['content-type']
          );
          if (offloadRes.offloaded) {
            bodyToPersist = { s3Uri: offloadRes.s3Uri, metadata: offloadRes.metadata };
          }
        }

        // Resolve and commit into storage
        await storage.resolve({
          tenantId,
          key,
          responseStatus: actionResult.statusCode,
          responseHeaders: actionResult.headers,
          responseBody: bodyToPersist,
          fencingToken,
        });

        // Broadcast resolution to all parked followers on this key
        parkingLot.broadcast(tenantId, key, {
          statusCode: actionResult.statusCode,
          headers: actionResult.headers,
          body: actionResult.body,
        });

        return {
          role: 'LEADER',
          statusCode: actionResult.statusCode,
          headers: actionResult.headers,
          body: actionResult.body,
          idempotencyStatus: 'MISS',
        };
      }

      // Transient failure status returned by upstream (e.g. 500, 502, 503, 504)
      const errorReason = `Upstream returned transient failure status ${actionResult.statusCode}`;
      await storage.abort({
        tenantId,
        key,
        errorReason,
        fencingToken,
      });

      parkingLot.abort(tenantId, key, errorReason);

      return {
        role: 'LEADER',
        statusCode: actionResult.statusCode,
        headers: actionResult.headers,
        body: actionResult.body,
        idempotencyStatus: 'MISS',
      };
    } catch (err: any) {
      // Upstream failed with exception: abort lease and broadcast failure to followers
      const errorReason = err?.message || 'Upstream execution failed';
      await storage.abort({
        tenantId,
        key,
        errorReason,
        fencingToken,
      });

      parkingLot.abort(tenantId, key, errorReason);
      throw err;
    }
  }

  // 3. Case B: CACHED -> Immediate cached replay
  if (acquireResult.status === 'CACHED' && acquireResult.record) {
    let replayedBody = acquireResult.record.responseBody;
    if (blobStorage && replayedBody) {
      replayedBody = await blobStorage.retrieveIfOffloaded(replayedBody);
    }

    return {
      role: 'FOLLOWER',
      statusCode: acquireResult.record.responseStatus ?? 200,
      headers: acquireResult.record.responseHeaders,
      body: replayedBody as T,
      idempotencyStatus: 'HIT',
    };
  }

  // 4. Case C: PAYLOAD_MISMATCH
  if (acquireResult.status === 'PAYLOAD_MISMATCH') {
    const err: any = new Error(`Payload mismatch detected for idempotency key "${key}".`);
    err.statusCode = 422;
    err.status = 'MISMATCH';
    throw err;
  }

  // 5. Case D: IN_PROGRESS -> Another leader is actively running, park this follower
  // Check adaptive backpressure before admitting to parking lot
  backpressure.assertCapacity(parkingLot, tenantId, key);

  const parkingHandler = new BoundedParkingHandler({
    parkingLot,
    tenantId,
    key,
    timeoutMs: parkingTimeoutMs,
  });

  const parkedWait = await parkingHandler.executeWait();

  if (parkedWait.status === 'RESOLVED') {
    let replayedBody = parkedWait.body;
    if (blobStorage && replayedBody) {
      replayedBody = await blobStorage.retrieveIfOffloaded(replayedBody);
    }

    return {
      role: 'FOLLOWER',
      statusCode: parkedWait.statusCode,
      headers: parkedWait.headers,
      body: replayedBody as T,
      idempotencyStatus: 'HIT',
    };
  }

  if (parkedWait.status === 'ABORTED') {
    const err: any = new Error(parkedWait.message);
    err.statusCode = 500;
    throw err;
  }

  // TIMEOUT
  const timeoutErr: any = new Error(parkedWait.response.message);
  timeoutErr.statusCode = 504;
  throw timeoutErr;
}
