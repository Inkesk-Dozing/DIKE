/**
 * DIKE Production Server Process Entrypoint
 * Handles process lifecycle, schema migrations, and graceful shutdown draining.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PostgresStorageAdapter } from '../storage/postgres.js';
import { DatabaseMigrator } from '../db/migrator.js';
import pg from 'pg';

export async function startServer(): Promise<void> {
  const config = loadConfig();

  // Initialize PostgreSQL pool & execute pending migrations
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    min: config.DATABASE_POOL_MIN,
    max: config.DATABASE_POOL_MAX,
  });

  const migrator = new DatabaseMigrator(pool);
  try {
    const applied = await migrator.migrate();
    if (applied.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[DIKE] Successfully applied ${applied.length} pending database migrations.`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[DIKE] Database migration warning: ${(err as Error).message}. Proceeding with active pool.`);
  }

  const storage = new PostgresStorageAdapter({ pool });
  const app = await buildApp({ config, storage });

  // Graceful Shutdown Signal Traps
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Received shutdown signal. Commencing graceful drain...');
    try {
      await app.close();
      await storage.close();
      app.log.info('Graceful shutdown completed successfully. Exiting.');
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error encountered during graceful shutdown.');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  try {
    const address = await app.listen({
      port: config.PORT,
      host: config.HOST,
    });
    app.log.info(`[DIKE] Distributed Idempotency Key Engine listening at ${address}`);
  } catch (err) {
    app.log.fatal(err, 'Failed to bind server port.');
    process.exit(1);
  }
}

// Auto-start if invoked directly via node
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  void startServer();
}
