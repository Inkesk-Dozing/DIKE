/**
 * PostgreSQL Database Migration Runner for DIKE
 * Executes versioned SQL migrations with transactional safety.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface MigrationResult {
  readonly version: string;
  readonly file: string;
  readonly executedAt: Date;
}

export class DatabaseMigrator {
  private readonly pool: Pool;
  private readonly migrationsDir: string;

  constructor(pool: Pool, migrationsDir?: string) {
    this.pool = pool;
    this.migrationsDir = migrationsDir ?? join(__dirname, 'migrations');
  }

  /**
   * Initializes the schema migration tracking table.
   */
  private async ensureMigrationTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  /**
   * Executes all pending SQL migration files sequentially.
   */
  public async migrate(): Promise<MigrationResult[]> {
    const client = await this.pool.connect();
    const results: MigrationResult[] = [];

    try {
      await this.ensureMigrationTable(client);

      const files = readdirSync(this.migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const version = file.split('_')[0] || file;

        // Check if already applied
        const { rows } = await client.query(
          'SELECT version FROM schema_migrations WHERE version = $1',
          [version]
        );

        if (rows.length > 0) {
          continue;
        }

        const sql = readFileSync(join(this.migrationsDir, file), 'utf-8');

        // Execute in atomic transaction
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
            [version, file]
          );
          await client.query('COMMIT');

          results.push({
            version,
            file,
            executedAt: new Date(),
          });
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Failed to apply migration "${file}": ${(err as Error).message}`);
        }
      }

      return results;
    } finally {
      client.release();
    }
  }
}
