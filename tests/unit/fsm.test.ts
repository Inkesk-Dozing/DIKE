import { describe, it, expect } from 'vitest';
import { IdempotencyFSM } from '../../src/core/fsm.js';
import {
  IllegalStateTransitionError,
  PayloadMismatchError,
  IdempotencyRecord,
} from '../../src/core/types.js';

describe('IdempotencyFSM State Machine', () => {
  const tenantId = 'tenant-alpha';
  const key = 'req-tx-1001';
  const fingerprint = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const ttlMs = 60_000;

  it('transitions from NON_EXISTENT to STARTED on fresh acquire', () => {
    const result = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
    expect(result.previousState).toBe('NON_EXISTENT');
    expect(result.currentState).toBe('STARTED');
    expect(result.record.status).toBe('STARTED');
    expect(result.record.key).toBe(key);
    expect(result.record.requestFingerprint).toBe(fingerprint);
    expect(result.record.fencingToken).toBe(1n);
  });

  it('transitions from STARTED to RESOLVED with response payload', () => {
    const startedResult = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
    const resolvedResult = IdempotencyFSM.transitionToResolved(
      startedResult.record,
      201,
      { 'content-type': 'application/json' },
      { orderId: 'ord-99' }
    );

    expect(resolvedResult.previousState).toBe('STARTED');
    expect(resolvedResult.currentState).toBe('RESOLVED');
    expect(resolvedResult.record.status).toBe('RESOLVED');
    expect(resolvedResult.record.responseStatus).toBe(201);
    expect(resolvedResult.record.responseBody).toEqual({ orderId: 'ord-99' });
    expect(resolvedResult.record.lockedUntil).toBeUndefined();
  });

  it('transitions from STARTED to FAILED on abort', () => {
    const startedResult = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
    const failedResult = IdempotencyFSM.transitionToFailed(startedResult.record, 'Upstream timeout');

    expect(failedResult.previousState).toBe('STARTED');
    expect(failedResult.currentState).toBe('FAILED');
    expect(failedResult.record.status).toBe('FAILED');
  });

  it('allows re-acquisition after FAILED state', () => {
    const startedResult = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
    const failedResult = IdempotencyFSM.transitionToFailed(startedResult.record, 'Network drop');

    const retryResult = IdempotencyFSM.transitionToStarted(failedResult.record, tenantId, key, fingerprint, ttlMs, 2n);
    expect(retryResult.previousState).toBe('FAILED');
    expect(retryResult.currentState).toBe('STARTED');
    expect(retryResult.record.fencingToken).toBe(2n);
  });

  it('throws IllegalStateTransitionError if trying to re-start a RESOLVED record', () => {
    const startedResult = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
    const resolvedResult = IdempotencyFSM.transitionToResolved(startedResult.record, 200, {}, { ok: true });

    expect(() => {
      IdempotencyFSM.transitionToStarted(resolvedResult.record, tenantId, key, fingerprint, ttlMs);
    }).toThrow(IllegalStateTransitionError);
  });

  it('throws PayloadMismatchError if key exists with different payload hash', () => {
    const startedResult = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
    const resolvedResult = IdempotencyFSM.transitionToResolved(startedResult.record, 200, {}, { ok: true });

    const mismatchedHash = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    expect(() => {
      IdempotencyFSM.transitionToStarted(resolvedResult.record, tenantId, key, mismatchedHash, ttlMs);
    }).toThrow(PayloadMismatchError);
  });

  it('blocks double resolve on already resolved record', () => {
    const startedResult = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
    const resolvedResult = IdempotencyFSM.transitionToResolved(startedResult.record, 200, {}, { ok: true });

    expect(() => {
      IdempotencyFSM.transitionToResolved(resolvedResult.record, 200);
    }).toThrow(IllegalStateTransitionError);
  });
});
