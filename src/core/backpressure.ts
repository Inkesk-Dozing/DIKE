/**
 * Adaptive Backpressure Controller for Parked Connections in DIKE
 * Enforces per-key and global concurrency limits on parked connections during flash crowds,
 * shedding excess duplicate requests with RFC 6585 HTTP 429 Too Many Requests and Retry-After headers
 * to prevent process heap exhaustion and unhandled socket degradation.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { ConnectionParkingLot } from './parking.js';
import { defaultLogger } from '../utils/logger.js';

export interface BackpressureConfig {
  /**
   * Hard cap on concurrent parked sockets per idempotency key.
   * Defaults to 500.
   */
  readonly maxParkedPerKey?: number;
  /**
   * Hard cap on total concurrent parked sockets across the whole node.
   * Defaults to 50,000.
   */
  readonly maxTotalParked?: number;
  /**
   * Number of seconds recommended for client retry when backpressure sheds a request.
   * Defaults to 2 seconds.
   */
  readonly retryAfterSeconds?: number;
}

export interface BackpressureCheckResult {
  readonly allowed: boolean;
  readonly reason?: 'OK' | 'KEY_LIMIT_EXCEEDED' | 'GLOBAL_LIMIT_EXCEEDED';
  readonly currentKeyParked: number;
  readonly maxParkedPerKey: number;
  readonly currentTotalParked: number;
  readonly maxTotalParked: number;
  readonly retryAfterSeconds: number;
}

export interface TooManyRequestsResponse {
  readonly statusCode: 429;
  readonly error: 'TooManyRequests';
  readonly message: string;
  readonly key: string;
  readonly tenantId: string;
  readonly retryAfter: number;
  readonly timestamp: string;
}

/**
 * Custom error thrown when a request is rejected by backpressure limits.
 */
export class BackpressureExceededError extends Error {
  public readonly statusCode = 429;
  public readonly retryAfter: number;
  public readonly key: string;
  public readonly tenantId: string;

  constructor(tenantId: string, key: string, retryAfter: number, reason: string) {
    super(`Adaptive backpressure triggered: ${reason}`);
    this.name = 'BackpressureExceededError';
    this.tenantId = tenantId;
    this.key = key;
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, BackpressureExceededError.prototype);
  }

  public toJSON(): TooManyRequestsResponse {
    return {
      statusCode: 429,
      error: 'TooManyRequests',
      message: this.message,
      key: this.key,
      tenantId: this.tenantId,
      retryAfter: this.retryAfter,
      timestamp: new Date().toISOString(),
    };
  }
}

export class AdaptiveBackpressureController {
  public readonly maxParkedPerKey: number;
  public readonly maxTotalParked: number;
  public readonly retryAfterSeconds: number;

  constructor(config: BackpressureConfig = {}) {
    this.maxParkedPerKey = config.maxParkedPerKey ?? 500;
    this.maxTotalParked = config.maxTotalParked ?? 50_000;
    this.retryAfterSeconds = config.retryAfterSeconds ?? 2;
  }

  /**
   * Evaluates whether a new follower connection for the given key and tenant can be safely parked.
   */
  public evaluate(parkingLot: ConnectionParkingLot, tenantId: string, key: string): BackpressureCheckResult {
    const currentKeyParked = parkingLot.getParkedCount(tenantId, key);
    const currentTotalParked = parkingLot.getTotalParkedCount();

    if (currentKeyParked >= this.maxParkedPerKey) {
      defaultLogger.warn({
        msg: 'Adaptive backpressure: per-key parking capacity reached, shedding incoming connection',
        tenantId,
        key,
        currentKeyParked,
        maxParkedPerKey: this.maxParkedPerKey,
        retryAfter: this.retryAfterSeconds,
      });

      return {
        allowed: false,
        reason: 'KEY_LIMIT_EXCEEDED',
        currentKeyParked,
        maxParkedPerKey: this.maxParkedPerKey,
        currentTotalParked,
        maxTotalParked: this.maxTotalParked,
        retryAfterSeconds: this.retryAfterSeconds,
      };
    }

    if (currentTotalParked >= this.maxTotalParked) {
      defaultLogger.warn({
        msg: 'Adaptive backpressure: global node parking capacity reached, shedding incoming connection',
        tenantId,
        key,
        currentTotalParked,
        maxTotalParked: this.maxTotalParked,
        retryAfter: this.retryAfterSeconds,
      });

      return {
        allowed: false,
        reason: 'GLOBAL_LIMIT_EXCEEDED',
        currentKeyParked,
        maxParkedPerKey: this.maxParkedPerKey,
        currentTotalParked,
        maxTotalParked: this.maxTotalParked,
        retryAfterSeconds: this.retryAfterSeconds,
      };
    }

    return {
      allowed: true,
      reason: 'OK',
      currentKeyParked,
      maxParkedPerKey: this.maxParkedPerKey,
      currentTotalParked,
      maxTotalParked: this.maxTotalParked,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }

  /**
   * Checks capacity and throws BackpressureExceededError if limit is breached.
   */
  public assertCapacity(parkingLot: ConnectionParkingLot, tenantId: string, key: string): void {
    const evaluation = this.evaluate(parkingLot, tenantId, key);
    if (!evaluation.allowed) {
      const reasonDetail =
        evaluation.reason === 'KEY_LIMIT_EXCEEDED'
          ? `Per-key concurrency limit of ${this.maxParkedPerKey} parked connections exceeded for key "${key}".`
          : `Global concurrency limit of ${this.maxTotalParked} parked connections exceeded on node.`;

      throw new BackpressureExceededError(tenantId, key, this.retryAfterSeconds, reasonDetail);
    }
  }
}

/**
 * Singleton default instance of AdaptiveBackpressureController.
 */
export const defaultBackpressureController = new AdaptiveBackpressureController();
