/**
 * Redis L2 Distributed Storage Adapter for DIKE
 * Coordinates distributed leases, TTLs, and cluster hash slot tagged records using ioredis.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { Redis, Cluster } from 'ioredis';
import { IIdempotencyStorage } from './interface.js';
import {
  IdempotencyRecord,
  AcquireOptions,
  AcquireResult,
  ResolveOptions,
  AbortOptions,
  FencingTokenViolationError,
} from '../core/types.js';
import { RedisConnectionManager, RedisPoolConfig, formatClusterHashTag } from './redis_pool.js';

interface RawSerializedRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly status: IdempotencyRecord['status'];
  readonly responseStatus?: number | undefined;
  readonly responseHeaders?: Record<string, string> | undefined;
  readonly responseBody?: unknown | undefined;
  readonly fencingToken?: string | undefined;
  readonly lockedUntil?: string | undefined;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseSerializedRecord(rawJson: string): IdempotencyRecord {
  const parsed = JSON.parse(rawJson) as RawSerializedRecord;
  return {
    id: parsed.id,
    tenantId: parsed.tenantId,
    key: parsed.key,
    requestFingerprint: parsed.requestFingerprint,
    status: parsed.status,
    responseStatus: parsed.responseStatus,
    responseHeaders: parsed.responseHeaders,
    responseBody: parsed.responseBody,
    fencingToken: parsed.fencingToken !== undefined ? BigInt(parsed.fencingToken) : undefined,
    lockedUntil: parsed.lockedUntil ? new Date(parsed.lockedUntil) : undefined,
    expiresAt: new Date(parsed.expiresAt),
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  };
}

export class RedisStorageAdapter implements IIdempotencyStorage {
  private readonly manager: RedisConnectionManager;
  private client: Redis | Cluster | null = null;

  constructor(config: RedisPoolConfig = {}) {
    this.manager = new RedisConnectionManager(config);
  }

  private async getActiveClient(): Promise<Redis | Cluster> {
    if (!this.client) {
      this.client = await this.manager.getClient();
    }
    return this.client;
  }

  public async acquire(options: AcquireOptions): Promise<AcquireResult> {
    const client = await this.getActiveClient();
    const redisKey = formatClusterHashTag(options.tenantId, options.key);
    const now = Date.now();
    const lockTimeout = options.lockTimeoutMs ?? 30_000;

    // Retrieve active record
    const existingRaw = await client.get(redisKey);

    if (existingRaw) {
      const existing = parseSerializedRecord(existingRaw);

      if (existing.expiresAt.getTime() <= now) {
        await client.del(redisKey);
      } else if (existing.status === 'RESOLVED') {
        if (existing.requestFingerprint !== options.requestFingerprint) {
          return { status: 'PAYLOAD_MISMATCH', record: existing };
        }
        return { status: 'CACHED', record: existing };
      } else if (existing.status === 'STARTED') {
        const isLocked = existing.lockedUntil && existing.lockedUntil.getTime() > now;
        if (isLocked) {
          if (existing.requestFingerprint !== options.requestFingerprint) {
            return { status: 'PAYLOAD_MISMATCH', record: existing };
          }
          return {
            status: 'IN_PROGRESS',
            record: existing,
            fencingToken: existing.fencingToken,
          };
        }
      }
    }

    // Allocate / take over lease with atomic fencing counter increment
    const fencingKey = formatClusterHashTag(options.tenantId, options.key, 'fence');
    const rawToken = await client.incr(fencingKey);
    const fencingToken = BigInt(rawToken);

    const record: IdempotencyRecord = {
      id: crypto.randomUUID(),
      tenantId: options.tenantId,
      key: options.key,
      requestFingerprint: options.requestFingerprint,
      status: 'STARTED',
      fencingToken,
      lockedUntil: new Date(now + Math.min(options.ttlMs, lockTimeout)),
      expiresAt: new Date(now + options.ttlMs),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };

    const serialized = JSON.stringify({
      ...record,
      fencingToken: fencingToken.toString(),
    });

    const ttlSeconds = Math.max(1, Math.ceil(options.ttlMs / 1000));
    await client.set(redisKey, serialized, 'EX', ttlSeconds);
    await client.expire(fencingKey, ttlSeconds);

    return {
      status: 'ACQUIRED',
      record,
      fencingToken,
    };
  }

  public async resolve(options: ResolveOptions): Promise<void> {
    const client = await this.getActiveClient();
    const redisKey = formatClusterHashTag(options.tenantId, options.key);
    const existingRaw = await client.get(redisKey);

    if (!existingRaw) {
      throw new Error(`Cannot resolve non-existent idempotency record for key "${options.key}".`);
    }

    const existing = parseSerializedRecord(existingRaw);
    const activeFencing = existing.fencingToken ?? 0n;

    if (options.fencingToken !== undefined && options.fencingToken < activeFencing) {
      throw new FencingTokenViolationError(options.key, activeFencing, options.fencingToken);
    }

    const now = new Date();
    const updated: IdempotencyRecord = {
      ...existing,
      status: 'RESOLVED',
      responseStatus: options.responseStatus,
      responseHeaders: options.responseHeaders,
      responseBody: options.responseBody,
      lockedUntil: undefined,
      updatedAt: now,
      fencingToken: activeFencing,
    };

    const remainingTtl = await client.ttl(redisKey);
    const effectiveTtl = remainingTtl > 0 ? remainingTtl : 86400;

    const serialized = JSON.stringify({
      ...updated,
      fencingToken: activeFencing.toString(),
    });

    await client.set(redisKey, serialized, 'EX', effectiveTtl);
  }

  public async abort(options: AbortOptions): Promise<void> {
    const client = await this.getActiveClient();
    const redisKey = formatClusterHashTag(options.tenantId, options.key);
    const existingRaw = await client.get(redisKey);

    if (!existingRaw) {
      return;
    }

    const existing = parseSerializedRecord(existingRaw);
    const activeFencing = existing.fencingToken ?? 0n;

    if (options.fencingToken !== undefined && options.fencingToken < activeFencing) {
      throw new FencingTokenViolationError(options.key, activeFencing, options.fencingToken);
    }

    const now = new Date();
    const updated: IdempotencyRecord = {
      ...existing,
      status: 'FAILED',
      lockedUntil: undefined,
      updatedAt: now,
      fencingToken: activeFencing,
    };

    const remainingTtl = await client.ttl(redisKey);
    const effectiveTtl = remainingTtl > 0 ? remainingTtl : 86400;

    const serialized = JSON.stringify({
      ...updated,
      fencingToken: activeFencing.toString(),
    });

    await client.set(redisKey, serialized, 'EX', effectiveTtl);
  }

  public async get(tenantId: string, key: string): Promise<IdempotencyRecord | null> {
    const client = await this.getActiveClient();
    const redisKey = formatClusterHashTag(tenantId, key);
    const raw = await client.get(redisKey);

    if (!raw) {
      return null;
    }

    const record = parseSerializedRecord(raw);

    if (record.expiresAt.getTime() <= Date.now()) {
      await client.del(redisKey);
      return null;
    }

    return record;
  }

  public async evict(tenantId: string, key: string): Promise<boolean> {
    const client = await this.getActiveClient();
    const redisKey = formatClusterHashTag(tenantId, key);
    const fenceKey = formatClusterHashTag(tenantId, key, 'fence');
    const deleted = await client.del(redisKey, fenceKey);
    return deleted > 0;
  }

  public async healthCheck(): Promise<boolean> {
    return this.manager.healthCheck();
  }

  public async close(): Promise<void> {
    await this.manager.close();
    this.client = null;
  }
}
