/**
 * Unit Test Suite for Monotonically Increasing Fencing Tokens & Zombie Writer Defenses
 * Tests monotonic token generation, guardrails, and zombie writer rejection across PostgreSQL and in-memory tiers.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, vi } from 'vitest';
import { FencingTokenGuard } from '../../src/core/fencing.js';
import { FencingTokenViolationError } from '../../src/core/types.js';
import { PostgresStorageAdapter } from '../../src/storage/postgres.js';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { Pool } from 'pg';

describe('Monotonically Increasing Fencing Tokens & Zombie Writer Defenses', () => {
  describe('FencingTokenGuard Core Logic', () => {
    it('increments tokens monotonically via nextToken()', () => {
      expect(FencingTokenGuard.nextToken()).toBe(1n);
      expect(FencingTokenGuard.nextToken(0n)).toBe(1n);
      expect(FencingTokenGuard.nextToken(1n)).toBe(2n);
      expect(FencingTokenGuard.nextToken(42n)).toBe(43n);
      expect(FencingTokenGuard.nextToken(999999999999999999n)).toBe(1000000000000000000n);
    });

    it('verifies candidate tokens accurately', () => {
      // Equal or greater token is valid
      const validEqual = FencingTokenGuard.verify(10n, 10n);
      expect(validEqual.valid).toBe(true);

      const validGreater = FencingTokenGuard.verify(10n, 12n);
      expect(validGreater.valid).toBe(true);

      // Candidate smaller than active token is marked invalid
      const stale = FencingTokenGuard.verify(15n, 14n);
      expect(stale.valid).toBe(false);
      expect(stale.reason).toContain('Zombie writer rejected');
    });

    it('throws FencingTokenViolationError on stale token assertion', () => {
      expect(() => {
        FencingTokenGuard.assertValid('tx-key-1', 20n, 19n);
      }).toThrow(FencingTokenViolationError);

      expect(() => {
        FencingTokenGuard.assertValid('tx-key-1', 20n, 20n);
      }).not.toThrow();

      expect(() => {
        FencingTokenGuard.assertValid('tx-key-1', 20n, 25n);
      }).not.toThrow();
    });
  });

  describe('PostgreSQL Zombie Writer Defense Protocol', () => {
    it('blocks zombie writer with lower fencing token on resolve()', async () => {
      const mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        query: vi.fn(),
        end: vi.fn(),
      } as unknown as Pool;

      const adapter = new PostgresStorageAdapter({ pool: mockPool });

      mockClient.query.mockImplementation(async (sql: string) => {
        if (sql.includes('BEGIN')) return {};
        if (sql.includes('SELECT fencing_token FROM idempotency_records')) {
          return {
            rows: [{ fencing_token: '15' }],
          };
        }
        if (sql.includes('ROLLBACK')) return {};
        return { rows: [] };
      });

      // Zombie worker attempts to resolve with stale token = 14n
      await expect(
        adapter.resolve({
          tenantId: 'tenant-fence',
          key: 'tx-fence-99',
          responseStatus: 200,
          fencingToken: 14n,
        })
      ).rejects.toThrow(FencingTokenViolationError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('blocks zombie writer with lower fencing token on abort()', async () => {
      const mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        query: vi.fn(),
        end: vi.fn(),
      } as unknown as Pool;

      const adapter = new PostgresStorageAdapter({ pool: mockPool });

      mockClient.query.mockImplementation(async (sql: string) => {
        if (sql.includes('BEGIN')) return {};
        if (sql.includes('SELECT fencing_token FROM idempotency_records')) {
          return {
            rows: [{ fencing_token: '25' }],
          };
        }
        if (sql.includes('ROLLBACK')) return {};
        return { rows: [] };
      });

      // Zombie worker attempts abort with stale token = 20n
      await expect(
        adapter.abort({
          tenantId: 'tenant-fence',
          key: 'tx-fence-100',
          errorReason: 'Zombie worker failure',
          fencingToken: 20n,
        })
      ).rejects.toThrow(FencingTokenViolationError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('In-Memory L1 Storage Fencing Verification', () => {
    it('rejects stale commit on memory adapter', async () => {
      const memoryAdapter = new MemoryStorageAdapter();

      // Acquire initial lease
      const first = await memoryAdapter.acquire({
        tenantId: 'tenant-mem',
        key: 'tx-fence-mem',
        requestFingerprint: 'hash-mem-1',
        ttlMs: 50,
        lockTimeoutMs: 50,
      });

      const initialToken = first.fencingToken!;
      expect(initialToken).toBeDefined();

      // Wait for lock to expire
      await new Promise((r) => setTimeout(r, 60));

      // Second worker takes over with higher monotonic token
      const second = await memoryAdapter.acquire({
        tenantId: 'tenant-mem',
        key: 'tx-fence-mem',
        requestFingerprint: 'hash-mem-1',
        ttlMs: 60_000,
      });

      expect(second.fencingToken!).toBeGreaterThan(initialToken);

      // First worker wakes up from pause and attempts resolve with stale initial token
      await expect(
        memoryAdapter.resolve({
          tenantId: 'tenant-mem',
          key: 'tx-fence-mem',
          responseStatus: 200,
          fencingToken: initialToken,
        })
      ).rejects.toThrow(FencingTokenViolationError);
    });
  });
});
