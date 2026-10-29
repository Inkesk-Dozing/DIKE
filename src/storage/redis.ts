/**
 * Redis L2 Distributed Storage Adapter for DIKE
 * Coordinates distributed leases, TTLs, and cluster hash slot tagged records using ioredis and atomic Lua scripts.
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
import { executeAcquireLeaseLua } from './lua/lua_runner.js';

interface RawSerializedRecord {
  readonly id: string;
  readonly tenantId?: string | undefined;
  readonly key?: string | undefined;
  readonly requestFingerprint: string;
  readonly status: IdempotencyRecord['status'];
  readonly responseStatus?: number | undefined;
  readonly responseHeaders?: Record<string, string> | undefined;
  readonly responseBody?: unknown | undefined;
  readonly fencingToken?: string | undefined;
  readonly lockedUntil?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly expiresAtMs?: number | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseSerializedRecord(rawJson: string, tenantId = '', key = ''): IdempotencyRecord {
  const parsed = JSON.parse(rawJson) as RawSerializedRecord;
  return {
    id: parsed.id,
    tenantId: parsed.tenantId || tenantId,
    key: parsed.key || key,
    requestFingerprint: parsed.requestFingerprint,
    status: parsed.status,
    responseStatus: parsed.responseStatus,
    responseHeaders: parsed.responseHeaders,
    responseBody: parsed.responseBody,
    fencingToken: parsed.fencingToken !== undefined ? BigInt(parsed.fencingToken) : undefined,
    lockedUntil: parsed.lockedUntil ? new Date(parsed.lockedUntil) : undefined,
    expiresAt: parsed.expiresAt
      ? new Date(parsed.expiresAt)
      : parsed.expiresAtMs
      ? new Date(parsed.expiresAtMs)
      : new Date(Date.now() + 86400000),
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
    // Execute atomic check-and-set via acquire_lease Lua script
    return executeAcquireLeaseLua(client, options);
  }

  public async resolve(options: ResolveOptions): Promise<void> {
    const client = await this.getActiveClient();
    const redisKey = formatClusterHashTag(options.tenantId, options.key);
    const existingRaw = await client.get(redisKey);

    if (!existingRaw) {
      throw new Error(`Cannot resolve non-existent idempotency record for key "${options.key}".`);
    }

    const existing = parseSerializedRecord(existingRaw, options.tenantId, options.key);
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

    const existing = parseSerializedRecord(existingRaw, options.tenantId, options.key);
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

    const record = parseSerializedRecord(raw, tenantId, key);

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
