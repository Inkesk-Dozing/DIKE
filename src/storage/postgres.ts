/**
 * PostgreSQL L3 Relational Storage Adapter for DIKE
 * Provides ACID durability, row-level locking (SELECT ... FOR UPDATE), GiST indexes, and zombie writer fencing.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { Pool, PoolClient } from 'pg';
import { IIdempotencyStorage } from './interface.js';
import {
  IdempotencyRecord,
  AcquireOptions,
  AcquireResult,
  ResolveOptions,
  AbortOptions,
} from '../core/types.js';
import { FencingTokenGuard } from '../core/fencing.js';

export interface PostgresStorageOptions {
  readonly connectionString?: string | undefined;
  readonly pool?: Pool | undefined;
  readonly maxPoolSize?: number | undefined;
  readonly defaultLockTimeoutMs?: number | undefined;
}

interface DBRecordRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly status: IdempotencyRecord['status'];
  readonly response_status: number | null;
  readonly response_headers: Record<string, string> | null;
  readonly response_body: unknown | null;
  readonly fencing_token: string;
  readonly locked_until: Date | null;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresStorageAdapter implements IIdempotencyStorage {
  private readonly pool: Pool;
  private readonly defaultLockTimeoutMs: number;
  private readonly ownsPool: boolean;

  constructor(options: PostgresStorageOptions = {}) {
    this.defaultLockTimeoutMs = options.defaultLockTimeoutMs ?? 30_000;
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        connectionString: options.connectionString || process.env['DATABASE_URL'] || 'postgresql://postgres:postgres@localhost:5432/dike_dev',
        max: options.maxPoolSize || 20,
      });
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
      fencingToken: BigInt(row.fencing_token),
      lockedUntil: row.locked_until ? new Date(row.locked_until) : undefined,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  public async acquire(options: AcquireOptions): Promise<AcquireResult> {
    const client: PoolClient = await this.pool.connect();
    const now = new Date();
    const lockDuration = options.lockTimeoutMs ?? this.defaultLockTimeoutMs;
    const lockedUntil = new Date(now.getTime() + Math.min(options.ttlMs, lockDuration));
    const expiresAt = new Date(now.getTime() + options.ttlMs);

    try {
      await client.query('BEGIN');

      // Row-level lock acquisition on tenant + idempotency key
      const selectRes = await client.query<DBRecordRow>(
        `SELECT * FROM idempotency_records 
         WHERE tenant_id = $1 AND idempotency_key = $2 
         FOR UPDATE`,
        [options.tenantId, options.key]
      );

      if (selectRes.rows.length > 0) {
        const existing = this.mapRowToRecord(selectRes.rows[0]!);

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
                 locked_until = $1, expires_at = $2, request_fingerprint = $3, updated_at = $4
             WHERE tenant_id = $5 AND idempotency_key = $6
             RETURNING *`,
            [lockedUntil, expiresAt, options.requestFingerprint, now, options.tenantId, options.key]
          );
          await client.query('COMMIT');
          const record = this.mapRowToRecord(updateRes.rows[0]!);
          return {
            status: 'ACQUIRED',
            record,
            fencingToken: record.fencingToken,
          };
        }

        if (existing.status === 'FAILED') {
          // Re-acquire on failed status
          const updateRes = await client.query<DBRecordRow>(
            `UPDATE idempotency_records 
             SET status = 'STARTED', fencing_token = fencing_token + 1,
                 locked_until = $1, expires_at = $2, request_fingerprint = $3, updated_at = $4
             WHERE tenant_id = $5 AND idempotency_key = $6
             RETURNING *`,
            [lockedUntil, expiresAt, options.requestFingerprint, now, options.tenantId, options.key]
          );
          await client.query('COMMIT');
          const record = this.mapRowToRecord(updateRes.rows[0]!);
          return {
            status: 'ACQUIRED',
            record,
            fencingToken: record.fencingToken,
          };
        }
      }

      // Fresh key insert
      const insertId = crypto.randomUUID();
      const insertRes = await client.query<DBRecordRow>(
        `INSERT INTO idempotency_records 
         (id, tenant_id, idempotency_key, request_fingerprint, status, fencing_token, locked_until, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'STARTED', 1, $5, $6, $7, $7)
         RETURNING *`,
        [insertId, options.tenantId, options.key, options.requestFingerprint, lockedUntil, expiresAt, now]
      );

      await client.query('COMMIT');
      const record = this.mapRowToRecord(insertRes.rows[0]!);
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
      FencingTokenGuard.assertValid(options.key, activeToken, options.fencingToken);

      await client.query(
        `UPDATE idempotency_records 
         SET status = 'RESOLVED',
             response_status = $1,
             response_headers = $2,
             response_body = $3,
             locked_until = NULL,
             updated_at = NOW()
         WHERE tenant_id = $4 AND idempotency_key = $5 AND fencing_token <= $6`,
        [
          options.responseStatus,
          options.responseHeaders ? JSON.stringify(options.responseHeaders) : null,
          options.responseBody ? JSON.stringify(options.responseBody) : null,
          options.tenantId,
          options.key,
          activeToken.toString(),
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
      await client.query('BEGIN');

      const selectRes = await client.query<DBRecordRow>(
        `SELECT fencing_token FROM idempotency_records 
         WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [options.tenantId, options.key]
      );

      if (selectRes.rows.length > 0) {
        const activeToken = BigInt(selectRes.rows[0]!.fencing_token);
        FencingTokenGuard.assertValid(options.key, activeToken, options.fencingToken);

        await client.query(
          `UPDATE idempotency_records 
           SET status = 'FAILED',
               locked_until = NULL,
               updated_at = NOW()
           WHERE tenant_id = $1 AND idempotency_key = $2 AND fencing_token <= $3`,
          [options.tenantId, options.key, activeToken.toString()]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
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

  public async healthCheck(): Promise<boolean> {
    try {
      const res = await this.pool.query('SELECT 1 as healthy');
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
