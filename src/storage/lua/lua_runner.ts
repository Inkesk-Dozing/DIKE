/**
 * Redis Lua Script Engine for Atomic Idempotency Operations
 * Bundles and executes acquire_lease.lua via EVALSHA with automatic EVAL fallback.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { Redis, Cluster } from 'ioredis';
import { createHash } from 'node:crypto';
import { AcquireOptions, AcquireResult, IdempotencyRecord } from '../../core/types.js';
import { formatClusterHashTag } from '../redis_pool.js';

export const ACQUIRE_LEASE_LUA_SCRIPT = `
local recordKey = KEYS[1]
local fencingKey = KEYS[2]

local fingerprint = ARGV[1]
local ttlMs = tonumber(ARGV[2]) or 86400000
local lockTimeoutMs = tonumber(ARGV[3]) or 30000
local currentTimeIso = ARGV[4]
local recordId = ARGV[5]
local nowMs = tonumber(ARGV[6]) or 0

local ttlSeconds = math.ceil(ttlMs / 1000)
if ttlSeconds < 1 then
  ttlSeconds = 1
end

local existingRaw = redis.call('GET', recordKey)

if existingRaw then
  local record = cjson.decode(existingRaw)
  local status = record.status
  local recordFingerprint = record.requestFingerprint

  if status == 'RESOLVED' then
    if recordFingerprint ~= fingerprint then
      return cjson.encode({
        status = 'PAYLOAD_MISMATCH',
        record = record
      })
    end
    return cjson.encode({
      status = 'CACHED',
      record = record
    })
  elseif status == 'STARTED' then
    local isLocked = true
    if record.lockedUntilMs and tonumber(record.lockedUntilMs) <= nowMs then
      isLocked = false
    end

    if isLocked then
      if recordFingerprint ~= fingerprint then
        return cjson.encode({
          status = 'PAYLOAD_MISMATCH',
          record = record
        })
      end
      return cjson.encode({
        status = 'IN_PROGRESS',
        record = record,
        fencingToken = record.fencingToken
      })
    end
  end
end

local rawFencing = redis.call('INCR', fencingKey)
redis.call('EXPIRE', fencingKey, ttlSeconds)

local lockedUntilMs = nowMs + math.min(ttlMs, lockTimeoutMs)

local newRecord = {
  id = recordId,
  requestFingerprint = fingerprint,
  status = 'STARTED',
  fencingToken = tostring(rawFencing),
  lockedUntilMs = lockedUntilMs,
  lockedUntil = currentTimeIso,
  expiresAtMs = nowMs + ttlMs,
  createdAt = currentTimeIso,
  updatedAt = currentTimeIso
}

local serialized = cjson.encode(newRecord)
redis.call('SET', recordKey, serialized, 'EX', ttlSeconds)

return cjson.encode({
  status = 'ACQUIRED',
  record = newRecord,
  fencingToken = tostring(rawFencing)
})
`;

export const ACQUIRE_LEASE_SHA = createHash('sha1').update(ACQUIRE_LEASE_LUA_SCRIPT).digest('hex');

export interface LuaScriptResponse {
  readonly status: 'ACQUIRED' | 'CACHED' | 'IN_PROGRESS' | 'PAYLOAD_MISMATCH';
  readonly record?: {
    readonly id: string;
    readonly requestFingerprint: string;
    readonly status: IdempotencyRecord['status'];
    readonly responseStatus?: number | undefined;
    readonly responseHeaders?: Record<string, string> | undefined;
    readonly responseBody?: unknown | undefined;
    readonly fencingToken?: string | undefined;
    readonly lockedUntil?: string | undefined;
    readonly expiresAtMs?: number | undefined;
    readonly createdAt: string;
    readonly updatedAt: string;
  } | undefined;
  readonly fencingToken?: string | undefined;
}

/**
 * Executes atomic lease acquisition script against Redis instance.
 */
export async function executeAcquireLeaseLua(
  client: Redis | Cluster,
  options: AcquireOptions
): Promise<AcquireResult> {
  const recordKey = formatClusterHashTag(options.tenantId, options.key);
  const fencingKey = formatClusterHashTag(options.tenantId, options.key, 'fence');

  const now = new Date();
  const nowMs = now.getTime();
  const recordId = crypto.randomUUID();
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000;

  let rawResult: string;

  try {
    // Attempt fast-path EVALSHA
    rawResult = (await (client as Redis).evalsha(
      ACQUIRE_LEASE_SHA,
      2,
      recordKey,
      fencingKey,
      options.requestFingerprint,
      options.ttlMs.toString(),
      lockTimeoutMs.toString(),
      now.toISOString(),
      recordId,
      nowMs.toString()
    )) as string;
  } catch (err: unknown) {
    const errorMsg = String(err);
    if (errorMsg.includes('NOSCRIPT')) {
      // Fallback to EVAL if script is not cached on Redis server
      rawResult = (await (client as Redis).eval(
        ACQUIRE_LEASE_LUA_SCRIPT,
        2,
        recordKey,
        fencingKey,
        options.requestFingerprint,
        options.ttlMs.toString(),
        lockTimeoutMs.toString(),
        now.toISOString(),
        recordId,
        nowMs.toString()
      )) as string;
    } else {
      throw err;
    }
  }

  const parsed = JSON.parse(rawResult) as LuaScriptResponse;

  let record: IdempotencyRecord | undefined;
  if (parsed.record) {
    record = {
      id: parsed.record.id,
      tenantId: options.tenantId,
      key: options.key,
      requestFingerprint: parsed.record.requestFingerprint,
      status: parsed.record.status,
      responseStatus: parsed.record.responseStatus,
      responseHeaders: parsed.record.responseHeaders,
      responseBody: parsed.record.responseBody,
      fencingToken:
        parsed.record.fencingToken !== undefined
          ? BigInt(parsed.record.fencingToken)
          : undefined,
      lockedUntil: parsed.record.lockedUntil ? new Date(parsed.record.lockedUntil) : undefined,
      expiresAt: parsed.record.expiresAtMs
        ? new Date(parsed.record.expiresAtMs)
        : new Date(nowMs + options.ttlMs),
      createdAt: new Date(parsed.record.createdAt),
      updatedAt: new Date(parsed.record.updatedAt),
    };
  }

  return {
    status: parsed.status,
    record,
    fencingToken: parsed.fencingToken ? BigInt(parsed.fencingToken) : undefined,
  };
}
