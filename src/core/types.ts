/**
 * Core Type Definitions for Distributed Idempotency Key Engine (DIKE)
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

export type IdempotencyState = 'NON_EXISTENT' | 'STARTED' | 'RESOLVED' | 'FAILED';

export type AcquireStatus = 'ACQUIRED' | 'CACHED' | 'IN_PROGRESS' | 'PAYLOAD_MISMATCH';

export interface IdempotencyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly status: IdempotencyState;
  readonly responseStatus?: number | undefined;
  readonly responseHeaders?: Record<string, string> | undefined;
  readonly responseBody?: unknown | undefined;
  readonly fencingToken?: bigint | undefined;
  readonly lockedUntil?: Date | undefined;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AcquireOptions {
  readonly tenantId: string;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly ttlMs: number;
  readonly lockTimeoutMs?: number | undefined;
}

export interface AcquireResult {
  readonly status: AcquireStatus;
  readonly record?: IdempotencyRecord | undefined;
  readonly fencingToken?: bigint | undefined;
}

export interface ResolveOptions {
  readonly tenantId: string;
  readonly key: string;
  readonly responseStatus: number;
  readonly responseHeaders?: Record<string, string> | undefined;
  readonly responseBody?: unknown | undefined;
  readonly fencingToken?: bigint | undefined;
}

export interface AbortOptions {
  readonly tenantId: string;
  readonly key: string;
  readonly errorReason: string;
  readonly fencingToken?: bigint | undefined;
}

export class IllegalStateTransitionError extends Error {
  constructor(
    public readonly fromState: IdempotencyState,
    public readonly toState: IdempotencyState,
    public readonly key: string
  ) {
    super(`Illegal state transition from ${fromState} to ${toState} for idempotency key "${key}".`);
    this.name = 'IllegalStateTransitionError';
  }
}

export class PayloadMismatchError extends Error {
  constructor(
    public readonly key: string,
    public readonly expectedFingerprint: string,
    public readonly receivedFingerprint: string
  ) {
    super(`Payload mismatch detected for idempotency key "${key}". Expected hash ${expectedFingerprint}, received ${receivedFingerprint}.`);
    this.name = 'PayloadMismatchError';
  }
}

export class FencingTokenViolationError extends Error {
  constructor(
    public readonly key: string,
    public readonly activeToken: bigint,
    public readonly staleToken: bigint
  ) {
    super(`Zombie writer blocked: active fencing token ${activeToken.toString()} is greater than stale token ${staleToken.toString()} for key "${key}".`);
    this.name = 'FencingTokenViolationError';
  }
}
