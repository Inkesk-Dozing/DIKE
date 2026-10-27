/**
 * Core Idempotency Finite State Machine (FSM)
 * Governs deterministic state transitions for request idempotency leases.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import {
  IdempotencyState,
  IdempotencyRecord,
  IllegalStateTransitionError,
  PayloadMismatchError,
} from './types.js';

export interface TransitionResult {
  readonly previousState: IdempotencyState;
  readonly currentState: IdempotencyState;
  readonly record: IdempotencyRecord;
}

export class IdempotencyFSM {
  /**
   * Evaluates and executes transition to 'STARTED' (acquire execution lease).
   */
  public static transitionToStarted(
    existingRecord: IdempotencyRecord | null,
    tenantId: string,
    key: string,
    fingerprint: string,
    ttlMs: number,
    fencingToken: bigint = 1n
  ): TransitionResult {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    if (!existingRecord) {
      const newRecord: IdempotencyRecord = {
        id: crypto.randomUUID(),
        tenantId,
        key,
        requestFingerprint: fingerprint,
        status: 'STARTED',
        fencingToken,
        lockedUntil: new Date(now.getTime() + Math.min(ttlMs, 30_000)),
        expiresAt,
        createdAt: now,
        updatedAt: now,
      };

      return {
        previousState: 'NON_EXISTENT',
        currentState: 'STARTED',
        record: newRecord,
      };
    }

    // Existing record evaluation
    if (existingRecord.status === 'RESOLVED') {
      if (existingRecord.requestFingerprint !== fingerprint) {
        throw new PayloadMismatchError(key, existingRecord.requestFingerprint, fingerprint);
      }
      throw new IllegalStateTransitionError('RESOLVED', 'STARTED', key);
    }

    if (existingRecord.status === 'FAILED') {
      // Re-acquire allowed after failure
      const updatedRecord: IdempotencyRecord = {
        ...existingRecord,
        requestFingerprint: fingerprint,
        status: 'STARTED',
        fencingToken,
        lockedUntil: new Date(now.getTime() + Math.min(ttlMs, 30_000)),
        expiresAt,
        updatedAt: now,
      };

      return {
        previousState: 'FAILED',
        currentState: 'STARTED',
        record: updatedRecord,
      };
    }

    if (existingRecord.status === 'STARTED') {
      // Check if lease is expired (zombie lock)
      const isLocked = existingRecord.lockedUntil && existingRecord.lockedUntil.getTime() > now.getTime();
      if (isLocked) {
        if (existingRecord.requestFingerprint !== fingerprint) {
          throw new PayloadMismatchError(key, existingRecord.requestFingerprint, fingerprint);
        }
        throw new IllegalStateTransitionError('STARTED', 'STARTED', key);
      }

      // Expired lock: take over
      const updatedRecord: IdempotencyRecord = {
        ...existingRecord,
        requestFingerprint: fingerprint,
        status: 'STARTED',
        fencingToken,
        lockedUntil: new Date(now.getTime() + Math.min(ttlMs, 30_000)),
        expiresAt,
        updatedAt: now,
      };

      return {
        previousState: 'STARTED',
        currentState: 'STARTED',
        record: updatedRecord,
      };
    }

    throw new IllegalStateTransitionError(existingRecord.status, 'STARTED', key);
  }

  /**
   * Executes transition to 'RESOLVED' upon successful upstream completion.
   */
  public static transitionToResolved(
    record: IdempotencyRecord,
    responseStatus: number,
    responseHeaders?: Record<string, string>,
    responseBody?: unknown
  ): TransitionResult {
    if (record.status !== 'STARTED') {
      throw new IllegalStateTransitionError(record.status, 'RESOLVED', record.key);
    }

    const now = new Date();
    const updatedRecord: IdempotencyRecord = {
      ...record,
      status: 'RESOLVED',
      responseStatus,
      responseHeaders,
      responseBody,
      lockedUntil: undefined,
      updatedAt: now,
    };

    return {
      previousState: 'STARTED',
      currentState: 'RESOLVED',
      record: updatedRecord,
    };
  }

  /**
   * Executes transition to 'FAILED' upon upstream mutation abortion or error.
   */
  public static transitionToFailed(
    record: IdempotencyRecord,
    _errorReason: string
  ): TransitionResult {
    if (record.status !== 'STARTED') {
      throw new IllegalStateTransitionError(record.status, 'FAILED', record.key);
    }

    const now = new Date();
    const updatedRecord: IdempotencyRecord = {
      ...record,
      status: 'FAILED',
      lockedUntil: undefined,
      updatedAt: now,
    };

    return {
      previousState: 'STARTED',
      currentState: 'FAILED',
      record: updatedRecord,
    };
  }
}
