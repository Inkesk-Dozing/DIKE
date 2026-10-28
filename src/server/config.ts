/**
 * Environment Configuration Engine for DIKE Server
 * Enforces strict environment schema validation via TypeBox.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { Type, Static } from '@sinclair/typebox';

export const ServerConfigSchema = Type.Object({
  PORT: Type.Number({ default: 3000 }),
  HOST: Type.String({ default: '0.0.0.0' }),
  NODE_ENV: Type.Union([
    Type.Literal('development'),
    Type.Literal('production'),
    Type.Literal('test'),
  ], { default: 'development' }),
  LOG_LEVEL: Type.Union([
    Type.Literal('fatal'),
    Type.Literal('error'),
    Type.Literal('warn'),
    Type.Literal('info'),
    Type.Literal('debug'),
    Type.Literal('trace'),
    Type.Literal('silent'),
  ], { default: 'info' }),
  DATABASE_URL: Type.String({ default: 'postgresql://postgres:postgres@localhost:5432/dike_dev' }),
  DATABASE_POOL_MIN: Type.Number({ default: 2 }),
  DATABASE_POOL_MAX: Type.Number({ default: 20 }),
  REDIS_URL: Type.String({ default: 'redis://localhost:6379' }),
  IDEMPOTENCY_DEFAULT_TTL_MS: Type.Number({ default: 86_400_000 }),
  IDEMPOTENCY_LOCK_TIMEOUT_MS: Type.Number({ default: 30_000 }),
  IDEMPOTENCY_PARKING_TIMEOUT_MS: Type.Number({ default: 10_000 }),
  IDEMPOTENCY_MAX_PAYLOAD_BYTES: Type.Number({ default: 5_242_880 }),
});

export type ServerConfig = Static<typeof ServerConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parseNum = (val: string | undefined, defaultVal: number): number => {
    if (!val) return defaultVal;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? defaultVal : parsed;
  };

  const nodeEnv = (env['NODE_ENV'] as ServerConfig['NODE_ENV']) || 'development';
  const logLevel = (env['LOG_LEVEL'] as ServerConfig['LOG_LEVEL']) || (nodeEnv === 'test' ? 'silent' : 'info');

  return {
    PORT: parseNum(env['PORT'], 3000),
    HOST: env['HOST'] || '0.0.0.0',
    NODE_ENV: nodeEnv,
    LOG_LEVEL: logLevel,
    DATABASE_URL: env['DATABASE_URL'] || 'postgresql://postgres:postgres@localhost:5432/dike_dev',
    DATABASE_POOL_MIN: parseNum(env['DATABASE_POOL_MIN'], 2),
    DATABASE_POOL_MAX: parseNum(env['DATABASE_POOL_MAX'], 20),
    REDIS_URL: env['REDIS_URL'] || 'redis://localhost:6379',
    IDEMPOTENCY_DEFAULT_TTL_MS: parseNum(env['IDEMPOTENCY_DEFAULT_TTL_MS'], 86_400_000),
    IDEMPOTENCY_LOCK_TIMEOUT_MS: parseNum(env['IDEMPOTENCY_LOCK_TIMEOUT_MS'], 30_000),
    IDEMPOTENCY_PARKING_TIMEOUT_MS: parseNum(env['IDEMPOTENCY_PARKING_TIMEOUT_MS'], 10_000),
    IDEMPOTENCY_MAX_PAYLOAD_BYTES: parseNum(env['IDEMPOTENCY_MAX_PAYLOAD_BYTES'], 5_242_880),
  };
}
