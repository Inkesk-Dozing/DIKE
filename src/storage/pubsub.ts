/**
 * Cross-Node Resolution Broadcasting via Redis Pub/Sub
 * Propagates completion and abortion events across distributed DIKE nodes,
 * unparking local follower connections when leader execution finishes on remote nodes.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { Redis, Cluster } from 'ioredis';
import { RedisConnectionManager, RedisPoolConfig, formatClusterHashTag } from './redis_pool.js';
import { ConnectionParkingLot, ParkedResponsePayload } from '../core/parking.js';

export type ResolutionEventType = 'RESOLVED' | 'ABORTED';

export interface ResolutionEventPayload {
  readonly type: ResolutionEventType;
  readonly tenantId: string;
  readonly key: string;
  readonly response?: ParkedResponsePayload | undefined;
  readonly errorReason?: string | undefined;
  readonly publishedAt: string;
}

export interface RedisPubSubBroadcasterOptions {
  readonly channelPrefix?: string | undefined;
}

export class RedisPubSubBroadcaster {
  private readonly manager: RedisConnectionManager;
  private readonly parkingLot: ConnectionParkingLot;
  private readonly channelPrefix: string;

  private publisherClient: Redis | Cluster | null = null;
  private subscriberClient: Redis | Cluster | null = null;
  private isSubscribed = false;
  private isClosed = false;

  constructor(
    config: RedisPoolConfig = {},
    parkingLot: ConnectionParkingLot,
    options: RedisPubSubBroadcasterOptions = {}
  ) {
    this.manager = new RedisConnectionManager(config);
    this.parkingLot = parkingLot;
    this.channelPrefix = options.channelPrefix ?? 'dike:events';
  }

  public getChannelPattern(): string {
    return `${this.channelPrefix}:*`;
  }

  public getChannelName(tenantId: string, key: string): string {
    const clusterTag = formatClusterHashTag(tenantId, key);
    return `${this.channelPrefix}:${clusterTag}`;
  }

  private async getPublisher(): Promise<Redis | Cluster> {
    if (!this.publisherClient) {
      this.publisherClient = await this.manager.getClient();
    }
    return this.publisherClient;
  }

  private async getSubscriber(): Promise<Redis | Cluster> {
    if (!this.subscriberClient) {
      // In Redis Pub/Sub, a client entering subscribe mode cannot execute ordinary commands.
      // Dedicated subscriber connection instantiated via manager.
      this.subscriberClient = await this.manager.getClient();
    }
    return this.subscriberClient;
  }

  /**
   * Subscribes the current node to cross-node resolution channels via pattern match.
   */
  public async subscribe(): Promise<void> {
    if (this.isSubscribed || this.isClosed) {
      return;
    }

    const sub = await this.getSubscriber();
    const pattern = this.getChannelPattern();

    if ('psubscribe' in sub && typeof sub.psubscribe === 'function') {
      await sub.psubscribe(pattern);
      (sub as Redis).on('pmessage', (_pattern: string, _channel: string, message: string) => {
        this.handleInboundMessage(message);
      });
      this.isSubscribed = true;
    }
  }

  /**
   * Processes inbound cross-node resolution broadcast and unparks matching local connections.
   */
  public handleInboundMessage(message: string): boolean {
    try {
      const event = JSON.parse(message) as ResolutionEventPayload;
      if (!event.tenantId || !event.key) {
        return false;
      }

      if (event.type === 'RESOLVED' && event.response) {
        this.parkingLot.broadcast(event.tenantId, event.key, event.response);
        return true;
      } else if (event.type === 'ABORTED' && event.errorReason) {
        this.parkingLot.abort(event.tenantId, event.key, event.errorReason);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Broadcasts mutation resolution across all cluster nodes.
   */
  public async publishResolution(
    tenantId: string,
    key: string,
    response: ParkedResponsePayload
  ): Promise<number> {
    const pub = await this.getPublisher();
    const channel = this.getChannelName(tenantId, key);

    const event: ResolutionEventPayload = {
      type: 'RESOLVED',
      tenantId,
      key,
      response,
      publishedAt: new Date().toISOString(),
    };

    const payload = JSON.stringify(event);
    const subscriberCount = await (pub as Redis).publish(channel, payload);

    // Also unpark any local connections on the current publishing node
    this.parkingLot.broadcast(tenantId, key, response);

    return subscriberCount;
  }

  /**
   * Broadcasts mutation failure/abort across all cluster nodes.
   */
  public async publishAbort(
    tenantId: string,
    key: string,
    errorReason: string
  ): Promise<number> {
    const pub = await this.getPublisher();
    const channel = this.getChannelName(tenantId, key);

    const event: ResolutionEventPayload = {
      type: 'ABORTED',
      tenantId,
      key,
      errorReason,
      publishedAt: new Date().toISOString(),
    };

    const payload = JSON.stringify(event);
    const subscriberCount = await (pub as Redis).publish(channel, payload);

    // Also abort local connections on the current node
    this.parkingLot.abort(tenantId, key, errorReason);

    return subscriberCount;
  }

  public async close(): Promise<void> {
    this.isClosed = true;
    if (this.subscriberClient) {
      try {
        if ('punsubscribe' in this.subscriberClient) {
          await (this.subscriberClient as Redis).punsubscribe(this.getChannelPattern());
        }
      } catch {
        // Suppress teardown errors
      }
    }
    await this.manager.close();
    this.publisherClient = null;
    this.subscriberClient = null;
    this.isSubscribed = false;
  }
}
