import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { PostgresStorageAdapter } from '../../src/storage/postgres.js';
import { DatabaseMigrator } from '../../src/db/migrator.js';
import { FencingTokenViolationError } from '../../src/core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('PostgreSQL Storage & Migrations (L3 ACID Tier)', () => {
  describe('DDL Migration Schema (001_initial_schema.sql)', () => {
    const migrationPath = join(__dirname, '../../src/db/migrations/001_initial_schema.sql');

    it('verifies migration file exists and contains valid DDL statements', () => {
      expect(existsSync(migrationPath)).toBe(true);
      const sql = readFileSync(migrationPath, 'utf-8');

      expect(sql).toContain('CREATE TABLE IF NOT EXISTS tenants');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS client_credentials');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS idempotency_records');
      expect(sql).toContain('uq_tenant_idempotency_key');
      expect(sql).toContain('idx_idempotency_lookup');
      expect(sql).toContain('idx_idempotency_cleanup');
    });
  });

  describe('DatabaseMigrator', () => {
    it('applies pending migrations inside atomic transaction', async () => {
      const mockClient = {
        query: vi.fn().mockImplementation((queryText: string) => {
          if (queryText.includes('SELECT version FROM schema_migrations')) {
            return Promise.resolve({ rows: [] }); // Not yet applied
          }
          return Promise.resolve({ rows: [] });
        }),
        release: vi.fn(),
      } as unknown as PoolClient;

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
      } as unknown as Pool;

      const migrator = new DatabaseMigrator(mockPool);
      const results = await migrator.migrate();

      expect(mockPool.connect).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.version).toBe('001');
    });
  });

  describe('PostgresStorageAdapter Unit Logic', () => {
    let mockClient: any;
    let mockPool: any;
    let storage: PostgresStorageAdapter;

    const tenantId = '11111111-1111-1111-1111-111111111111';
    const key = 'tx-order-888';
    const fingerprint = 'a'.repeat(64);

    beforeEach(() => {
      mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        query: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined),
      };
      storage = new PostgresStorageAdapter({ pool: mockPool as unknown as Pool });
    });

    it('acquires new key when record does not exist', async () => {
      // 1. SELECT returns 0 rows
      mockClient.query.mockImplementationOnce((sql: string) => {
        expect(sql).toBe('BEGIN');
        return Promise.resolve({ rows: [] });
      });
      mockClient.query.mockImplementationOnce((sql: string) => {
        expect(sql).toContain('SELECT * FROM idempotency_records');
        return Promise.resolve({ rows: [] });
      });
      // 2. INSERT returns inserted row
      const now = new Date();
      mockClient.query.mockImplementationOnce((sql: string) => {
        expect(sql).toContain('INSERT INTO idempotency_records');
        return Promise.resolve({
          rows: [
            {
              id: 'uuid-1',
              tenant_id: tenantId,
              idempotency_key: key,
              request_fingerprint: fingerprint,
              status: 'STARTED',
              response_status: null,
              response_headers: null,
              response_body: null,
              fencing_token: '1',
              locked_until: new Date(now.getTime() + 30_000),
              expires_at: new Date(now.getTime() + 86_400_000),
              created_at: now,
              updated_at: now,
            },
          ],
        });
      });
      mockClient.query.mockImplementationOnce((sql: string) => {
        expect(sql).toBe('COMMIT');
        return Promise.resolve({ rows: [] });
      });

      const res = await storage.acquire({
        tenantId,
        key,
        requestFingerprint: fingerprint,
        ttlMs: 86_400_000,
      });

      expect(res.status).toBe('ACQUIRED');
      expect(res.record?.key).toBe(key);
      expect(res.fencingToken).toBe(1n);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('returns CACHED when key is already RESOLVED with matching fingerprint', async () => {
      const now = new Date();
      mockClient.query.mockImplementationOnce(() => Promise.resolve({ rows: [] })); // BEGIN
      mockClient.query.mockImplementationOnce(() =>
        Promise.resolve({
          rows: [
            {
              id: 'uuid-1',
              tenant_id: tenantId,
              idempotency_key: key,
              request_fingerprint: fingerprint,
              status: 'RESOLVED',
              response_status: 200,
              response_headers: { 'content-type': 'application/json' },
              response_body: { orderId: '123' },
              fencing_token: '1',
              locked_until: null,
              expires_at: new Date(now.getTime() + 50_000),
              created_at: now,
              updated_at: now,
            },
          ],
        })
      );
      mockClient.query.mockImplementationOnce(() => Promise.resolve({ rows: [] })); // COMMIT

      const res = await storage.acquire({
        tenantId,
        key,
        requestFingerprint: fingerprint,
        ttlMs: 86_400_000,
      });

      expect(res.status).toBe('CACHED');
      expect(res.record?.responseStatus).toBe(200);
      expect(res.record?.responseBody).toEqual({ orderId: '123' });
    });

    it('detects PAYLOAD_MISMATCH on duplicate key with mismatched hash', async () => {
      const now = new Date();
      mockClient.query.mockImplementationOnce(() => Promise.resolve({ rows: [] })); // BEGIN
      mockClient.query.mockImplementationOnce(() =>
        Promise.resolve({
          rows: [
            {
              id: 'uuid-1',
              tenant_id: tenantId,
              idempotency_key: key,
              request_fingerprint: fingerprint,
              status: 'RESOLVED',
              response_status: 200,
              fencing_token: '1',
              locked_until: null,
              expires_at: new Date(now.getTime() + 50_000),
              created_at: now,
              updated_at: now,
            },
          ],
        })
      );
      mockClient.query.mockImplementationOnce(() => Promise.resolve({ rows: [] })); // COMMIT

      const res = await storage.acquire({
        tenantId,
        key,
        requestFingerprint: 'b'.repeat(64),
        ttlMs: 86_400_000,
      });

      expect(res.status).toBe('PAYLOAD_MISMATCH');
    });

    it('blocks zombie writer trying to resolve with stale fencing token', async () => {
      mockClient.query.mockImplementationOnce(() => Promise.resolve({ rows: [] })); // BEGIN
      mockClient.query.mockImplementationOnce(() =>
        Promise.resolve({
          rows: [{ fencing_token: '5' }], // Active token is 5
        })
      );

      await expect(
        storage.resolve({
          tenantId,
          key,
          responseStatus: 200,
          fencingToken: 4n, // Stale token 4 < 5
        })
      ).rejects.toThrow(FencingTokenViolationError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('performs health check query successfully', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ alive: 1 }] });
      const isHealthy = await storage.healthCheck();
      expect(isHealthy).toBe(true);
    });
  });
});
