--[[
  Atomic Lease Acquisition Lua Script for DIKE
  Executes check-and-set idempotency lease acquisition in a single atomic roundtrip.
  Eliminates race conditions between concurrent requests under high load.
  Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash

  KEYS[1]: Primary record key (e.g., "{tenantId:key}")
  KEYS[2]: Fencing token key (e.g., "{tenantId:key}:fence")

  ARGV[1]: Request fingerprint (e.g., SHA-256 hash)
  ARGV[2]: TTL in milliseconds (e.g., 86400000)
  ARGV[3]: Lock timeout in milliseconds (e.g., 30000)
  ARGV[4]: Current timestamp ISO string / epoch ms
  ARGV[5]: Generated record UUID

  Returns JSON string encoded payload:
  {
    "status": "ACQUIRED" | "CACHED" | "IN_PROGRESS" | "PAYLOAD_MISMATCH",
    "record": {...},
    "fencingToken": "string"
  }
]]

local recordKey = KEYS[1]
local fencingKey = KEYS[2]

local fingerprint = ARGV[1]
local ttlMs = tonumber(ARGV[2]) or 86400000
local lockTimeoutMs = tonumber(ARGV[3]) or 30000
local currentTimeIso = ARGV[4]
local recordId = ARGV[5]

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
    local lockedUntil = record.lockedUntil
    local isLocked = true

    if lockedUntil and record.lockedUntilMs then
      local nowMs = tonumber(currentTimeIso) or 0
      if record.lockedUntilMs <= nowMs then
        isLocked = false
      end
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
    -- Lock has expired (zombie lock): take over
  end
end

-- Atomically increment monotonic fencing token
local rawFencing = redis.call('INCR', fencingKey)
redis.call('EXPIRE', fencingKey, ttlSeconds)

local nowMs = tonumber(currentTimeIso) or 0
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
