/**
 * Unit Test Suite for Cross-Node Resolution Broadcasting via Redis Pub/Sub
 * Tests cross-instance message publishing, psubscribe message handling, local and remote unparking, and clean listener teardown.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionParkingLot } from '../../src/core/parking.js';
import { RedisPubSubBroadcaster } from '../../src/storage/pubsub.js';

// Shared mock bus to route publish calls across mock client instances
const sharedSubscribers: Function[] = [];

vi.mock('ioredis', () => {
  class MockRedis {
    public callbacks = new Map<string, Function[]>();
    public publishedMessages: Array<{ channel: string; message: string }> = [];

    public ping = vi.fn().mockResolvedValue('PONG');
    public quit = vi.fn().mockResolvedValue('OK');
    public disconnect = vi.fn().mockReturnValue(undefined);

    public publish = vi.fn().mockImplementation(async (channel: string, message: string) => {
      this.publishedMessages.push({ channel, message });
      for (const cb of sharedSubscribers) {
        cb('dike:events:*', channel, message);
      }
      return sharedSubscribers.length;
    });

    public psubscribe = vi.fn().mockImplementation(async (_pattern: string) => {
      return 'OK';
    });

    public punsubscribe = vi.fn().mockImplementation(async (_pattern: string) => {
      return 'OK';
    });

    public on = vi.fn().mockImplementation((event: string, callback: Function) => {
      if (event === 'pmessage') {
        sharedSubscribers.push(callback);
      }
      const list = this.callbacks.get(event) ?? [];
      list.push(callback);
      this.callbacks.set(event, list);
      return this;
    });
  }

  class MockCluster extends MockRedis {}

  return {
    Redis: MockRedis,
    Cluster: MockCluster,
    default: MockRedis,
  };
});

describe('Cross-Node Resolution Broadcasting via Redis Pub/Sub', () => {
  let parkingLotNode1: ConnectionParkingLot;
  let parkingLotNode2: ConnectionParkingLot;
  let broadcasterNode1: RedisPubSubBroadcaster;
  let broadcasterNode2: RedisPubSubBroadcaster;

  beforeEach(() => {
    sharedSubscribers.length = 0;
    parkingLotNode1 = new ConnectionParkingLot();
    parkingLotNode2 = new ConnectionParkingLot();

    broadcasterNode1 = new RedisPubSubBroadcaster({}, parkingLotNode1);
    broadcasterNode2 = new RedisPubSubBroadcaster({}, parkingLotNode2);
  });

  it('generates consistent cluster slot hash tagged channel names', () => {
    const channel = broadcasterNode1.getChannelName('tenant-xyz', 'order-123');
    expect(channel).toBe('dike:events:{tenant-xyz:order-123}');
    expect(broadcasterNode1.getChannelPattern()).toBe('dike:events:*');
  });

  it('unparks followers across simulated cluster nodes when Node 1 publishes resolution', async () => {
    const tenantId = 'tenant-distributed';
    const key = 'tx-cluster-101';

    // Node 2 has a follower connection parked waiting for this key
    await broadcasterNode2.subscribe();
    const node2FollowerPromise = parkingLotNode2.waitFor(tenantId, key);
    expect(parkingLotNode2.getParkedCount(tenantId, key)).toBe(1);

    // Node 1 (executing the leader transaction) publishes resolution
    const resolvedPayload = {
      statusCode: 200,
      headers: { 'x-node': 'node-1' },
      body: { chargeId: 'ch_99999' },
    };

    const subscriberCount = await broadcasterNode1.publishResolution(tenantId, key, resolvedPayload);
    expect(subscriberCount).toBe(1);

    // Node 2 follower receives event and unparks cleanly
    const node2Result = await node2FollowerPromise;
    expect(node2Result.status).toBe('RESOLVED');
    expect(node2Result.response?.statusCode).toBe(200);
    expect(node2Result.response?.headers?.['x-node']).toBe('node-1');
    expect(node2Result.response?.body).toEqual({ chargeId: 'ch_99999' });

    // Parking lot cleared on Node 2
    expect(parkingLotNode2.getParkedCount(tenantId, key)).toBe(0);
  });

  it('propagates abort event across nodes and aborts parked follower connections', async () => {
    const tenantId = 'tenant-distributed';
    const key = 'tx-cluster-abort';

    await broadcasterNode2.subscribe();
    const node2FollowerPromise = parkingLotNode2.waitFor(tenantId, key);

    await broadcasterNode1.publishAbort(tenantId, key, 'Downstream payment gateway error 502');

    const result = await node2FollowerPromise;
    expect(result.status).toBe('ABORTED');
    expect(result.errorReason).toBe('Downstream payment gateway error 502');
    expect(parkingLotNode2.getParkedCount(tenantId, key)).toBe(0);
  });

  it('handles invalid or malformed JSON payloads gracefully without crashing', () => {
    expect(broadcasterNode1.handleInboundMessage('invalid-json')).toBe(false);
    expect(broadcasterNode1.handleInboundMessage(JSON.stringify({ incomplete: true }))).toBe(false);
  });

  it('cleans up pub/sub connections and unsubscriptions on close()', async () => {
    await broadcasterNode1.subscribe();
    await expect(broadcasterNode1.close()).resolves.toBeUndefined();
  });
});
