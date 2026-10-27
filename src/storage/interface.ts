/**
 * Abstract Storage Adapter Interface for DIKE
 * Defines uniform ACID and cache contracts across L1 (Memory), L2 (Redis), and L3 (PostgreSQL).
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import {
  IdempotencyRecord,
  AcquireOptions,
  AcquireResult,
  ResolveOptions,
  AbortOptions,
} from '../core/types.js';

export interface IIdempotencyStorage {
  /**
   * Attempts to atomically acquire an idempotency lease.
   */
  acquire(options: AcquireOptions): Promise<AcquireResult>;

  /**
   * Commits the completed response payload, transitioning status to RESOLVED.
   */
  resolve(options: ResolveOptions): Promise<void>;

  /**
   * Releases or flags the idempotency key as FAILED upon upstream failure.
   */
  abort(options: AbortOptions): Promise<void>;

  /**
   * Retrieves the active or cached idempotency record, or null if non-existent or expired.
   */
  get(tenantId: string, key: string): Promise<IdempotencyRecord | null>;

  /**
   * Explicitly evicts or purges a key from the storage tier.
   */
  evict(tenantId: string, key: string): Promise<boolean>;

  /**
   * Gracefully closes database pools or network sockets.
   */
  close(): Promise<void>;
}
