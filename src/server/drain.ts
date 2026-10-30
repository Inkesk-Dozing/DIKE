/**
 * Rolling Zero-Downtime Socket Drainage Engine (`preStop` Lifecycle Handler) for DIKE
 * Coordinates graceful shutdown during Kubernetes rolling updates:
 * shifts Ingress away via /readyz 503, holds termination while active parked sockets drain,
 * rejects new incoming mutations, and closes storage pools cleanly.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ConnectionParkingLot } from '../core/parking.js';
import { defaultLogger } from '../utils/logger.js';

export type DrainState = 'RUNNING' | 'DRAINING' | 'DRAINED';

export interface DrainManagerOptions {
  /**
   * Reference to the ConnectionParkingLot multiplexer to inspect active sockets.
   */
  readonly parkingLot?: ConnectionParkingLot | undefined;
  /**
   * Maximum grace period in milliseconds to await parked socket drainage.
   * Defaults to 15,000 ms (15 seconds).
   */
  readonly drainTimeoutMs?: number | undefined;
  /**
   * Polling interval in milliseconds while checking if active sockets reached zero.
   * Defaults to 250 ms.
   */
  readonly checkIntervalMs?: number | undefined;
  /**
   * Custom clock for deterministic unit testing.
   */
  readonly clock?: (() => number) | undefined;
}

export class DrainManager {
  private state: DrainState = 'RUNNING';
  public readonly parkingLot?: ConnectionParkingLot | undefined;
  public readonly drainTimeoutMs: number;
  public readonly checkIntervalMs: number;
  private readonly clock: () => number;
  private drainStartedAt: number | null = null;
  private activeMutationsCount: number = 0;

  constructor(options: DrainManagerOptions = {}) {
    this.parkingLot = options.parkingLot;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 15_000;
    this.checkIntervalMs = options.checkIntervalMs ?? 250;
    this.clock = options.clock ?? (() => Date.now());
  }

  public getState(): DrainState {
    return this.state;
  }

  public isDraining(): boolean {
    return this.state === 'DRAINING' || this.state === 'DRAINED';
  }

  public trackMutationStart(): void {
    if (this.isDraining()) {
      throw new Error('Server is currently draining; new mutations cannot be accepted.');
    }
    this.activeMutationsCount++;
  }

  public trackMutationEnd(): void {
    this.activeMutationsCount = Math.max(0, this.activeMutationsCount - 1);
  }

  public getActiveSocketsCount(): number {
    const parkedCount = this.parkingLot ? this.parkingLot.getTotalParkedCount() : 0;
    return parkedCount + this.activeMutationsCount;
  }

  /**
   * Initiates the drainage sequence (triggered by Kubernetes preStop hook or SIGTERM).
   */
  public async startDrain(app?: FastifyInstance): Promise<{ success: boolean; remainingSockets: number; elapsedMs: number }> {
    if (this.state === 'DRAINED') {
      return { success: true, remainingSockets: 0, elapsedMs: 0 };
    }

    this.state = 'DRAINING';
    this.drainStartedAt = this.clock();

    defaultLogger.warn({
      msg: 'Server entering DRAINING state: Kubernetes preStop / SIGTERM received',
      drainTimeoutMs: this.drainTimeoutMs,
      initialActiveSockets: this.getActiveSocketsCount(),
    });

    const startTime = this.drainStartedAt;
    const deadline = startTime + this.drainTimeoutMs;

    // Loop until all active sockets drain or grace period elapses
    while (this.clock() < deadline) {
      const active = this.getActiveSocketsCount();
      if (active === 0) {
        this.state = 'DRAINED';
        const elapsedMs = this.clock() - startTime;
        defaultLogger.info({
          msg: 'All active parked sockets and in-flight mutations successfully drained',
          elapsedMs,
        });

        if (app) {
          await app.close().catch((err) => {
            defaultLogger.error({ msg: 'Error closing Fastify during drainage', err });
          });
        }

        return { success: true, remainingSockets: 0, elapsedMs };
      }

      await new Promise((resolve) => setTimeout(resolve, this.checkIntervalMs));
    }

    // Timeout breached
    const remaining = this.getActiveSocketsCount();
    this.state = 'DRAINED';
    const elapsedMs = this.clock() - startTime;

    defaultLogger.error({
      msg: 'Drain grace period expired with remaining sockets active',
      remainingSockets: remaining,
      elapsedMs,
      drainTimeoutMs: this.drainTimeoutMs,
    });

    if (app) {
      await app.close().catch((err) => {
        defaultLogger.error({ msg: 'Error closing Fastify during forced drainage exit', err });
      });
    }

    return { success: false, remainingSockets: remaining, elapsedMs };
  }
}

/**
 * Fastify plugin attaching /drain endpoint and onRequest drainage guardrails.
 */
export const socketDrainPlugin: FastifyPluginAsync<{ drainManager: DrainManager }> = async (
  app: FastifyInstance,
  opts
): Promise<void> => {
  const drainManager = opts.drainManager;

  // Decorate app with drain manager
  app.decorate('drainManager', drainManager);

  // Reject new incoming mutation requests if server is draining
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Probes and metrics are exempt from drainage rejection
    if (req.url === '/healthz' || req.url === '/readyz' || req.url === '/drain') {
      return;
    }

    if (drainManager.isDraining()) {
      return reply
        .status(503)
        .header('Retry-After', '2')
        .header('Connection', 'close')
        .send({
          statusCode: 503,
          error: 'ServiceUnavailable',
          message: 'Server is currently undergoing rolling maintenance and draining connections. Retry request on sibling pod.',
          timestamp: new Date().toISOString(),
        });
    }
  });

  /**
   * POST /drain - Kubernetes preStop lifecycle hook endpoint
   */
  app.post('/drain', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!drainManager.isDraining()) {
      // Run drainage asynchronously or await completion
      const result = await drainManager.startDrain();
      return reply.status(200).send({
        status: 'DRAINED',
        success: result.success,
        remainingSockets: result.remainingSockets,
        elapsedMs: result.elapsedMs,
        timestamp: new Date().toISOString(),
      });
    }

    return reply.status(200).send({
      status: drainManager.getState(),
      activeSockets: drainManager.getActiveSocketsCount(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Intercept SIGTERM and SIGINT process signals for graceful drainage
   */
  const signalHandler = async (signal: string): Promise<void> => {
    defaultLogger.info({ msg: `Received ${signal}; triggering zero-downtime socket drainage` });
    await drainManager.startDrain(app);
  };

  process.once('SIGTERM', () => signalHandler('SIGTERM'));
  process.once('SIGINT', () => signalHandler('SIGINT'));
};

export const socketDrain = fp(socketDrainPlugin, {
  name: 'socket-drain-plugin',
  fastify: '5.x',
});
