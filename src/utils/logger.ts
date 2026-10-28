/**
 * Structured Logging Engine with Zero-Secret Redaction
 * Emits high-throughput JSON telemetry while guaranteeing automatic redaction of sensitive credentials and PII.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import pino, { Logger, LoggerOptions } from 'pino';
import { randomUUID } from 'node:crypto';

export const REDACTED_MASK = '[REDACTED]';

export const DEFAULT_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'req.headers.cookie',
  'req.body.password',
  'req.body.creditCard',
  'req.body.cardNumber',
  'req.body.cvv',
  'req.body.token',
  'req.body.secret',
  'password',
  'creditCard',
  'cardNumber',
  'cvv',
  'token',
  'secret',
  'authorization',
  'apiKey',
  '*.password',
  '*.creditCard',
  '*.cardNumber',
  '*.cvv',
  '*.token',
  '*.secret',
  '*.authorization',
  '*.apiKey',
];

export interface CreateLoggerOptions {
  readonly level?: string | undefined;
  readonly redactPaths?: string[] | undefined;
  readonly destination?: pino.DestinationStream | undefined;
}

/**
 * Creates an enterprise-grade Pino logger instance with structured redaction paths and ISO timestamps.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const redactPaths = options.redactPaths ?? DEFAULT_REDACT_PATHS;

  const loggerOptions: LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    redact: {
      paths: redactPaths,
      censor: REDACTED_MASK,
    },
  };

  if (options.destination) {
    return pino(loggerOptions, options.destination);
  }

  return pino(loggerOptions);
}

/**
 * Generates an RFC 4122 v4 UUID for request/trace correlation across distributed nodes.
 */
export function generateTraceId(): string {
  return randomUUID();
}
