/**
 * Exhaustive Vitest Unit Test Suite for Idempotency Finite State Machine (FSM)
 * Tests full state transition matrix, zombie takeovers, payload mismatches, and boundary invariants.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect } from 'vitest';
import { IdempotencyFSM } from '../../src/core/fsm.js';
import {
  IllegalStateTransitionError,
  PayloadMismatchError,
  IdempotencyRecord,
  IdempotencyState,
} from '../../src/core/types.js';

describe('IdempotencyFSM State Machine Exhaustive Verification', () => {
  const tenantId = 'tenant-alpha';
  const key = 'req-tx-1001';
  const fingerprint = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const ttlMs = 60_000;

  describe('Fresh Lease Transitions (NON_EXISTENT -> STARTED)', () => {
    it('transitions from null/undefined to STARTED with unique UUID and monotonic fencing token', () => {
      const result = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs, 42n);
      expect(result.previousState).toBe('NON_EXISTENT');
      expect(result.currentState).toBe('STARTED');
      expect(result.record.status).toBe('STARTED');
      expect(result.record.id).toBeDefined();
      expect(result.record.tenantId).toBe(tenantId);
      expect(result.record.key).toBe(key);
      expect(result.record.requestFingerprint).toBe(fingerprint);
      expect(result.record.fencingToken).toBe(42n);
      expect(result.record.lockedUntil).toBeDefined();
      expect(result.record.expiresAt.getTime()).toBeGreaterThan(result.record.createdAt.getTime());
    });

    it('defaults fencingToken to 1n when not explicitly specified', () => {
      const result = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      expect(result.record.fencingToken).toBe(1n);
    });
  });

  describe('Lifecycle State Transitions (STARTED -> RESOLVED / FAILED)', () => {
    it('transitions from STARTED to RESOLVED with status code, headers, and payload', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      const headers = { 'content-type': 'application/json', 'x-custom': 'val' };
      const body = { success: true, balance: 100 };

      const resolved = IdempotencyFSM.transitionToResolved(started.record, 201, headers, body);
      expect(resolved.previousState).toBe('STARTED');
      expect(resolved.currentState).toBe('RESOLVED');
      expect(resolved.record.status).toBe('RESOLVED');
      expect(resolved.record.responseStatus).toBe(201);
      expect(resolved.record.responseHeaders).toEqual(headers);
      expect(resolved.record.responseBody).toEqual(body);
      expect(resolved.record.lockedUntil).toBeUndefined();
    });

    it('transitions from STARTED to FAILED with error reason', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      const failed = IdempotencyFSM.transitionToFailed(started.record, 'Network timeout');

      expect(failed.previousState).toBe('STARTED');
      expect(failed.currentState).toBe('FAILED');
      expect(failed.record.status).toBe('FAILED');
      expect(failed.record.lockedUntil).toBeUndefined();
    });
  });

  describe('Takeover and Retry Invariants', () => {
    it('allows re-acquisition after FAILED state (FAILED -> STARTED)', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      const failed = IdempotencyFSM.transitionToFailed(started.record, 'Downstream abort');

      const retry = IdempotencyFSM.transitionToStarted(failed.record, tenantId, key, fingerprint, ttlMs, 5n);
      expect(retry.previousState).toBe('FAILED');
      expect(retry.currentState).toBe('STARTED');
      expect(retry.record.status).toBe('STARTED');
      expect(retry.record.fencingToken).toBe(5n);
    });

    it('allows zombie lock takeover when lockedUntil timestamp has elapsed in the past', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      // Simulate expired zombie lock
      const expiredRecord: IdempotencyRecord = {
        ...started.record,
        lockedUntil: new Date(Date.now() - 5000), // 5 seconds in the past
      };

      const takeover = IdempotencyFSM.transitionToStarted(expiredRecord, tenantId, key, fingerprint, ttlMs, 10n);
      expect(takeover.previousState).toBe('STARTED');
      expect(takeover.currentState).toBe('STARTED');
      expect(takeover.record.fencingToken).toBe(10n);
    });

    it('blocks acquisition and throws IllegalStateTransitionError if lock is still actively held', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      // Lock is valid for 30s
      expect(() => {
        IdempotencyFSM.transitionToStarted(started.record, tenantId, key, fingerprint, ttlMs);
      }).toThrow(IllegalStateTransitionError);
    });
  });

  describe('Payload Mismatch & Security Invariants', () => {
    it('throws PayloadMismatchError when attempting to re-acquire an active lock with divergent fingerprint', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      const divergentHash = 'b'.repeat(64);

      expect(() => {
        IdempotencyFSM.transitionToStarted(started.record, tenantId, key, divergentHash, ttlMs);
      }).toThrow(PayloadMismatchError);
    });

    it('throws PayloadMismatchError when attempting to re-acquire a RESOLVED record with divergent fingerprint', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      const resolved = IdempotencyFSM.transitionToResolved(started.record, 200);
      const divergentHash = 'c'.repeat(64);

      expect(() => {
        IdempotencyFSM.transitionToStarted(resolved.record, tenantId, key, divergentHash, ttlMs);
      }).toThrow(PayloadMismatchError);
    });

    it('throws IllegalStateTransitionError when attempting to re-acquire a RESOLVED record with identical fingerprint', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      const resolved = IdempotencyFSM.transitionToResolved(started.record, 200);

      expect(() => {
        IdempotencyFSM.transitionToStarted(resolved.record, tenantId, key, fingerprint, ttlMs);
      }).toThrow(IllegalStateTransitionError);
    });
  });

  describe('Illegal Transition Guardrails', () => {
    it('blocks transitionToResolved from non-STARTED states (RESOLVED, FAILED)', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      const resolved = IdempotencyFSM.transitionToResolved(started.record, 200);
      const failed = IdempotencyFSM.transitionToFailed(started.record, 'err');

      // Double resolve
      expect(() => {
        IdempotencyFSM.transitionToResolved(resolved.record, 200);
      }).toThrow(IllegalStateTransitionError);

      // Resolve from failed
      expect(() => {
        IdempotencyFSM.transitionToResolved(failed.record, 200);
      }).toThrow(IllegalStateTransitionError);
    });

    it('blocks transitionToFailed from non-STARTED states (RESOLVED, FAILED)', () => {
      const started = IdempotencyFSM.transitionToStarted(null, tenantId, key, fingerprint, ttlMs);
      const resolved = IdempotencyFSM.transitionToResolved(started.record, 200);
      const failed = IdempotencyFSM.transitionToFailed(started.record, 'err');

      // Fail from resolved
      expect(() => {
        IdempotencyFSM.transitionToFailed(resolved.record, 'err');
      }).toThrow(IllegalStateTransitionError);

      // Double fail
      expect(() => {
        IdempotencyFSM.transitionToFailed(failed.record, 'err');
      }).toThrow(IllegalStateTransitionError);
    });

    it('rejects transitionToStarted from unknown or unhandled status', () => {
      const anomalousRecord = {
        id: 'fake-id',
        tenantId,
        key,
        requestFingerprint: fingerprint,
        status: 'CORRUPTED' as unknown as IdempotencyState,
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(() => {
        IdempotencyFSM.transitionToStarted(anomalousRecord, tenantId, key, fingerprint, ttlMs);
      }).toThrow(IllegalStateTransitionError);
    });
  });
});
