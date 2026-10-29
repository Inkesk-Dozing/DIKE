/**
 * Asynchronous Connection Parking Engine (EventBus Multiplexer)
 * Suspends concurrent duplicate HTTP mutation sockets in memory with zero polling overhead,
 * resolving them simultaneously when the leader execution completes.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { EventEmitter } from 'node:events';

export interface ParkedResponsePayload {
  readonly statusCode: number;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: unknown | undefined;
}

export type ParkingResolutionStatus = 'RESOLVED' | 'ABORTED' | 'TIMEOUT';

export interface ParkingResult {
  readonly status: ParkingResolutionStatus;
  readonly response?: ParkedResponsePayload | undefined;
  readonly errorReason?: string | undefined;
}

export interface ConnectionParkingLotOptions {
  readonly defaultTimeoutMs?: number | undefined;
  readonly maxParkedPerKey?: number | undefined;
  readonly maxTotalParked?: number | undefined;
}

export class ConnectionParkingLot {
  private readonly emitter = new EventEmitter();
  private readonly defaultTimeoutMs: number;
  private readonly maxParkedPerKey: number;
  private readonly maxTotalParked: number;
  private currentParkedCount = 0;
  private readonly keyParkedCounts = new Map<string, number>();

  constructor(options: ConnectionParkingLotOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.maxParkedPerKey = options.maxParkedPerKey ?? 1_000;
    this.maxTotalParked = options.maxTotalParked ?? 50_000;
    // Configure emitter to support large concurrent follower bursts
    this.emitter.setMaxListeners(0);
  }

  private channelName(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  /**
   * Parks the caller connection until the leader broadcasts completion or timeout elapses.
   */
  public waitFor(
    tenantId: string,
    key: string,
    timeoutMs?: number | undefined
  ): Promise<ParkingResult> {
    const channel = this.channelName(tenantId, key);
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;

    // Backpressure check
    if (this.currentParkedCount >= this.maxTotalParked) {
      return Promise.resolve({
        status: 'TIMEOUT',
        errorReason: `Global connection parking lot capacity of ${this.maxTotalParked} exceeded.`,
      });
    }

    const currentKeyCount = this.keyParkedCounts.get(channel) ?? 0;
    if (currentKeyCount >= this.maxParkedPerKey) {
      return Promise.resolve({
        status: 'TIMEOUT',
        errorReason: `Key parking lot capacity of ${this.maxParkedPerKey} exceeded for channel "${channel}".`,
      });
    }

    this.currentParkedCount++;
    this.keyParkedCounts.set(channel, currentKeyCount + 1);

    return new Promise<ParkingResult>((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.currentParkedCount = Math.max(0, this.currentParkedCount - 1);
        const count = this.keyParkedCounts.get(channel) ?? 1;
        if (count <= 1) {
          this.keyParkedCounts.delete(channel);
        } else {
          this.keyParkedCounts.set(channel, count - 1);
        }
      };

      const onResolve = (response: ParkedResponsePayload): void => {
        cleanup();
        this.emitter.removeListener(`${channel}:abort`, onAbort);
        resolve({
          status: 'RESOLVED',
          response,
        });
      };

      const onAbort = (reason: string): void => {
        cleanup();
        this.emitter.removeListener(`${channel}:resolve`, onResolve);
        resolve({
          status: 'ABORTED',
          errorReason: reason,
        });
      };

      this.emitter.once(`${channel}:resolve`, onResolve);
      this.emitter.once(`${channel}:abort`, onAbort);

      timer = setTimeout(() => {
        this.emitter.removeListener(`${channel}:resolve`, onResolve);
        this.emitter.removeListener(`${channel}:abort`, onAbort);
        cleanup();
        resolve({
          status: 'TIMEOUT',
          errorReason: `Parking duration exceeded timeout of ${effectiveTimeout}ms for key "${key}".`,
        });
      }, effectiveTimeout);

      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }

  /**
   * Broadcasts successful resolution to all followers parked on the channel.
   * Returns count of unparked connections.
   */
  public broadcast(
    tenantId: string,
    key: string,
    response: ParkedResponsePayload
  ): number {
    const channel = this.channelName(tenantId, key);
    const count = this.keyParkedCounts.get(channel) ?? 0;
    this.emitter.emit(`${channel}:resolve`, response);
    return count;
  }

  /**
   * Broadcasts abort/failure notification to all followers parked on the channel.
   * Returns count of unparked connections.
   */
  public abort(
    tenantId: string,
    key: string,
    errorReason: string
  ): number {
    const channel = this.channelName(tenantId, key);
    const count = this.keyParkedCounts.get(channel) ?? 0;
    this.emitter.emit(`${channel}:abort`, errorReason);
    return count;
  }

  public getParkedCount(tenantId: string, key: string): number {
    const channel = this.channelName(tenantId, key);
    return this.keyParkedCounts.get(channel) ?? 0;
  }

  public getTotalParkedCount(): number {
    return this.currentParkedCount;
  }

  public clear(): void {
    this.emitter.removeAllListeners();
    this.currentParkedCount = 0;
    this.keyParkedCounts.clear();
  }
}
