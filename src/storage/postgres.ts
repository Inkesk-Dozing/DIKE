/**
 * PostgreSQL L3 ACID Storage Adapter for DIKE
 * Provides durable, persistent transactional guarantees and row-level locking for idempotency keys.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import pg, { Pool, PoolConfig } from 'pg';
import { IIdempotencyStorage } from './interface.js';
import {
  IdempotencyRecord,
  AcquireOptions,
  AcquireResult,
  ResolveOptions,
  AbortOptions,
  FencingTokenViolationError,
} from '../core/types.js';

export interface PostgresStorageOptions {
  readonly pool?: Pool | undefined;
  readonly poolConfig?: PoolConfig | undefined;
  readonly defaultLockTimeoutMs?: number | undefined;
}

interface DBRecordRow {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: 'STARTED' | 'RESOLVED' | 'FAILED';
  response_status: number | null;
  response_headers: Record<string, string> | null;
  response_body: unknown | null;
  fencing_token: string | number | bigint;
  locked_until: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export class PostgresStorageAdapter implements IIdempotencyStorage {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly defaultLockTimeoutMs: number;

  constructor(options: PostgresStorageOptions = {}) {
    this.defaultLockTimeoutMs = options.defaultLockTimeoutMs ?? 30_000;
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new pg.Pool(options.poolConfig);
      this.ownsPool = true;
    }
  }

  private mapRowToRecord(row: DBRecordRow): IdempotencyRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      key: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      status: row.status,
      responseStatus: row.response_status ?? undefined,
      responseHeaders: row.response_headers ?? undefined,
      responseBody: row.response_body ?? undefined,
      fencingToken: row.fencing_token ? BigInt(row.fencing_token) : undefined,
      lockedUntil: row.locked_until ?? undefined,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  public async acquire(options: AcquireOptions): Promise<AcquireResult> {
    const client = await this.pool.connect();
    const now = new Date();
    const lockTimeoutMs = options.lockTimeoutMs ?? this.defaultLockTimeoutMs;
    const lockedUntil = new Date(now.getTime() + Math.min(options.ttlMs, lockTimeoutMs));
    const expiresAt = new Date(now.getTime() + options.ttlMs);

    try {
      await client.query('BEGIN');

      // Row-level lock acquisition
      const selectRes = await client.query<DBRecordRow>(
        `SELECT * FROM idempotency_records 
         WHERE tenant_id = $1 AND idempotency_key = $2 
         FOR UPDATE`,
        [options.tenantId, options.key]
      );

      if (selectRes.rows.length === 0) {
        // Fresh insertion
        const insertRes = await client.query<DBRecordRow>(
          `INSERT INTO idempotency_records (
            tenant_id, idempotency_key, request_fingerprint, status, 
            fencing_token, locked_until, expires_at, created_at, updated_at
           ) VALUES ($1, $2, $3, 'STARTED', 1, $4, $5, $6, $6)
           RETURNING *`,
          [options.tenantId, options.key, options.requestFingerprint, lockedUntil, expiresAt, now]
        );

        await client.query('COMMIT');
        const insertedRecord = this.mapRowToRecord(insertRes.rows[0]!);
        return {
          status: 'ACQUIRED',
          record: insertedRecord,
          fencingToken: 1n,
        };
      }

      const existingRow = selectRes.rows[0]!;
      const existing = this.mapRowToRecord(existingRow);

      // Check if expired
      if (existing.expiresAt.getTime() <= now.getTime()) {
        const updateRes = await client.query<DBRecordRow>(
          `UPDATE idempotency_records 
           SET request_fingerprint = $1, status = 'STARTED', fencing_token = fencing_token + 1,
               locked_until = $2, expires_at = $3, response_status = NULL, 
               response_headers = NULL, response_body = NULL, updated_at = $4
           WHERE tenant_id = $5 AND idempotency_key = $6
           RETURNING *`,
          [options.requestFingerprint, lockedUntil, expiresAt, now, options.tenantId, options.key]
        );
        await client.query('COMMIT');
        const record = this.mapRowToRecord(updateRes.rows[0]!);
        return {
          status: 'ACQUIRED',
          record,
          fencingToken: record.fencingToken,
        };
      }

      if (existing.status === 'RESOLVED') {
        await client.query('COMMIT');
        if (existing.requestFingerprint !== options.requestFingerprint) {
          return { status: 'PAYLOAD_MISMATCH', record: existing };
        }
        return { status: 'CACHED', record: existing };
      }

      if (existing.status === 'STARTED') {
        const isLocked = existing.lockedUntil && existing.lockedUntil.getTime() > now.getTime();
        if (isLocked) {
          await client.query('COMMIT');
          if (existing.requestFingerprint !== options.requestFingerprint) {
            return { status: 'PAYLOAD_MISMATCH', record: existing };
          }
          return {
            status: 'IN_PROGRESS',
            record: existing,
            fencingToken: existing.fencingToken,
          };
        }

        // Lock expired: take over lease
        const updateRes = await client.query<DBRecordRow>(
          `UPDATE idempotency_records 
           SET status = 'STARTED', fencing_token = fencing_token + 1,
               locked_until = $1, expires_at = $2, updated_at = $3
           WHERE tenant_id = $4 AND idempotency_key = $5
           RETURNING *`,
          [lockedUntil, expiresAt, now, options.tenantId, options.key]
        );
        await client.query('COMMIT');
        const record = this.mapRowToRecord(updateRes.rows[0]!);
        return {
          status: 'ACQUIRED',
          record,
          fencingToken: record.fencingToken,
        };
      }

      // FAILED state: allow retry
      const updateRes = await client.query<DBRecordRow>(
        `UPDATE idempotency_records 
         SET request_fingerprint = $1, status = 'STARTED', fencing_token = fencing_token + 1,
             locked_until = $2, expires_at = $3, updated_at = $4
         WHERE tenant_id = $5 AND idempotency_key = $6
         RETURNING *`,
        [options.requestFingerprint, lockedUntil, expiresAt, now, options.tenantId, options.key]
      );
      await client.query('COMMIT');
      const record = this.mapRowToRecord(updateRes.rows[0]!);
      return {
        status: 'ACQUIRED',
        record,
        fencingToken: record.fencingToken,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async resolve(options: ResolveOptions): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const selectRes = await client.query<DBRecordRow>(
        `SELECT fencing_token FROM idempotency_records 
         WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [options.tenantId, options.key]
      );

      if (selectRes.rows.length === 0) {
        throw new Error(`Record for key "${options.key}" does not exist in PostgreSQL storage.`);
      }

      const activeToken = BigInt(selectRes.rows[0]!.fencing_token);
      if (options.fencingToken !== undefined && options.fencingToken < activeToken) {
        throw new FencingTokenViolationError(options.key, activeToken, options.fencingToken);
      }

      await client.query(
        `UPDATE idempotency_records 
         SET status = 'RESOLVED',
             response_status = $1,
             response_headers = $2,
             response_body = $3,
             locked_until = NULL,
             updated_at = NOW()
         WHERE tenant_id = $4 AND idempotency_key = $5`,
        [
          options.responseStatus,
          options.responseHeaders ? JSON.stringify(options.responseHeaders) : null,
          options.responseBody ? JSON.stringify(options.responseBody) : null,
          options.tenantId,
          options.key,
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async abort(options: AbortOptions): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE idempotency_records 
         SET status = 'FAILED',
             locked_until = NULL,
             updated_at = NOW()
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [options.tenantId, options.key]
      );
    } finally {
      client.release();
    }
  }

  public async get(tenantId: string, key: string): Promise<IdempotencyRecord | null> {
    const res = await this.pool.query<DBRecordRow>(
      `SELECT * FROM idempotency_records WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const record = this.mapRowToRecord(res.rows[0]!);
    if (record.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return record;
  }

  public async evict(tenantId: string, key: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM idempotency_records WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key]
    );
    return (res.rowCount ?? 0) > 0;
  }

  public async sweepExpired(): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM idempotency_records WHERE expires_at <= NOW()`
    );
    return res.rowCount ?? 0;
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const res = await this.pool.query('SELECT 1 as alive');
      return res.rows.length > 0;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
