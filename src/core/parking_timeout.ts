/**
 * Bounded Client Parking Timeout Handlers for DIKE
 * Manages bounded parking wait times for duplicate HTTP follower requests,
 * emitting RFC 9110 / HTTP 504 Gateway Timeout responses upon leader stalls,
 * and ensuring deterministic listener and memory cleanup.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { ConnectionParkingLot, ParkingResult, ParkedResponsePayload } from './parking.js';
import { defaultLogger } from '../utils/logger.js';

export interface BoundedParkingOptions {
  /**
   * Reference to the ConnectionParkingLot multiplexer.
   */
  readonly parkingLot: ConnectionParkingLot;
  /**
   * Target tenant identifier.
   */
  readonly tenantId: string;
  /**
   * Idempotency key.
   */
  readonly key: string;
  /**
   * Bounded timeout in milliseconds. Defaults to 15,000 ms (15s).
   */
  readonly timeoutMs?: number;
  /**
   * Optional trace identifier for correlated telemetry.
   */
  readonly traceId?: string | undefined;
  /**
   * Optional custom clock for deterministic testing.
   */
  readonly clock?: () => number;
}

export interface GatewayTimeoutResponse {
  readonly statusCode: 504;
  readonly error: 'GatewayTimeout';
  readonly message: string;
  readonly key: string;
  readonly tenantId: string;
  readonly elapsedMs: number;
  readonly timestamp: string;
}

export type BoundedWaitResult =
  | {
    readonly status: 'RESOLVED';
    readonly statusCode: number;
    readonly headers?: Record<string, string> | undefined;
    readonly body?: unknown | undefined;
    readonly elapsedMs: number;
  }
  | {
    readonly status: 'ABORTED';
    readonly statusCode: 500;
    readonly error: 'UpstreamAborted';
    readonly message: string;
    readonly key: string;
    readonly tenantId: string;
    readonly elapsedMs: number;
  }
  | {
    readonly status: 'TIMEOUT';
    readonly response: GatewayTimeoutResponse;
    readonly elapsedMs: number;
  };

/**
 * Custom error thrown when a parked follower times out waiting for the leader.
 */
export class GatewayTimeoutError extends Error {
  public readonly statusCode = 504;
  public readonly key: string;
  public readonly tenantId: string;
  public readonly elapsedMs: number;

  constructor(tenantId: string, key: string, timeoutMs: number, elapsedMs: number) {
    super(
      `Idempotent operation for key "${key}" timed out after ${elapsedMs}ms (limit: ${timeoutMs}ms) waiting for leader resolution.`
    );
    this.name = 'GatewayTimeoutError';
    this.tenantId = tenantId;
    this.key = key;
    this.elapsedMs = elapsedMs;
    Object.setPrototypeOf(this, GatewayTimeoutError.prototype);
  }

  public toJSON(): GatewayTimeoutResponse {
    return {
      statusCode: 504,
      error: 'GatewayTimeout',
      message: this.message,
      key: this.key,
      tenantId: this.tenantId,
      elapsedMs: this.elapsedMs,
      timestamp: new Date().toISOString(),
    };
  }
}

export class BoundedParkingHandler {
  public readonly parkingLot: ConnectionParkingLot;
  public readonly tenantId: string;
  public readonly key: string;
  public readonly timeoutMs: number;
  public readonly traceId: string | undefined;
  private readonly clock: () => number;

  constructor(options: BoundedParkingOptions) {
    if (!options.parkingLot) {
      throw new Error('BoundedParkingHandler requires a valid ConnectionParkingLot instance.');
    }
    if (!options.tenantId) {
      throw new Error('BoundedParkingHandler requires a non-empty tenantId.');
    }
    if (!options.key) {
      throw new Error('BoundedParkingHandler requires a non-empty key.');
    }

    this.parkingLot = options.parkingLot;
    this.tenantId = options.tenantId;
    this.key = options.key;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.traceId = options.traceId;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Waits for the leader execution to resolve or abort within the bounded timeout window.
   * If the window elapses, cleans up resources and returns a structured 504 Gateway Timeout result.
   */
  public async executeWait(): Promise<BoundedWaitResult> {
    const startTime = this.clock();

    defaultLogger.debug({
      msg: 'Parking connection with bounded timeout handler',
      tenantId: this.tenantId,
      key: this.key,
      timeoutMs: this.timeoutMs,
      traceId: this.traceId,
    });

    const result: ParkingResult = await this.parkingLot.waitFor(
      this.tenantId,
      this.key,
      this.timeoutMs
    );

    const elapsedMs = Math.max(0, this.clock() - startTime);

    if (result.status === 'RESOLVED' && result.response) {
      defaultLogger.debug({
        msg: 'Parked connection unparked successfully by leader resolution',
        tenantId: this.tenantId,
        key: this.key,
        elapsedMs,
        statusCode: result.response.statusCode,
        traceId: this.traceId,
      });

      return {
        status: 'RESOLVED',
        statusCode: result.response.statusCode,
        headers: result.response.headers,
        body: result.response.body,
        elapsedMs,
      };
    }

    if (result.status === 'ABORTED') {
      defaultLogger.warn({
        msg: 'Parked connection unparked due to leader abort',
        tenantId: this.tenantId,
        key: this.key,
        elapsedMs,
        reason: result.errorReason,
        traceId: this.traceId,
      });

      return {
        status: 'ABORTED',
        statusCode: 500,
        error: 'UpstreamAborted',
        message: result.errorReason ?? `Leader execution aborted for idempotency key "${this.key}".`,
        key: this.key,
        tenantId: this.tenantId,
        elapsedMs,
      };
    }

    // TIMEOUT or backpressure rejection
    const timeoutError = new GatewayTimeoutError(this.tenantId, this.key, this.timeoutMs, elapsedMs);

    defaultLogger.warn({
      msg: 'Parked connection timed out waiting for leader resolution',
      tenantId: this.tenantId,
      key: this.key,
      elapsedMs,
      timeoutLimitMs: this.timeoutMs,
      reason: result.errorReason,
      traceId: this.traceId,
    });

    return {
      status: 'TIMEOUT',
      response: timeoutError.toJSON(),
      elapsedMs,
    };
  }
}

/**
 * Convenience helper to park a follower request with bounded timeout,
 * resolving to a standardized HTTP reply payload or throwing GatewayTimeoutError if strict error mode is set.
 */
export async function waitWithBoundedTimeout(
  options: BoundedParkingOptions,
  throwOnTimeout = false
): Promise<BoundedWaitResult> {
  const handler = new BoundedParkingHandler(options);
  const result = await handler.executeWait();

  if (throwOnTimeout && result.status === 'TIMEOUT') {
    throw new GatewayTimeoutError(options.tenantId, options.key, options.timeoutMs ?? 15_000, result.elapsedMs);
  }

  return result;
}