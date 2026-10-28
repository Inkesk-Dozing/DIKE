/**
 * IETF Idempotency-Key Standard HTTP Header Compliance Plugin
 * Implements draft-ietf-httpapi-idempotency-key-header-05 specification for Fastify.
 * Validates request headers and decorates responses with standardized idempotency metadata.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

export const IETF_IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IETF_IDEMPOTENCY_STATUS_HEADER = 'idempotency-status';
export const IETF_IDEMPOTENCY_REPLAYED_AT_HEADER = 'idempotency-replayed-at';

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Validates that an Idempotency-Key header value conforms to IETF RFC/draft constraints:
 * 1. Non-empty string.
 * 2. Maximum length of 255 characters.
 * 3. ASCII printable characters only (0x21 to 0x7E, visible non-whitespace/space standard).
 */
export function validateIdempotencyKey(key: string): { valid: boolean; reason?: string } {
  if (!key || key.length === 0) {
    return { valid: false, reason: 'Idempotency-Key header cannot be empty.' };
  }

  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return {
      valid: false,
      reason: `Idempotency-Key header length exceeds maximum permitted limit of ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    };
  }

  // Enforce visible ASCII printable range (33 - 126) or standard RFC-7230 quoted string / token
  // Strictly disallow control characters, line breaks, null bytes, or multi-byte UTF-8
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    // Allow space (32) and printable ASCII characters (33 - 126)
    if (code < 32 || code > 126) {
      return {
        valid: false,
        reason: 'Idempotency-Key header contains illegal non-ASCII or control characters.',
      };
    }
  }

  return { valid: true };
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string | undefined;
    isIdempotentRequest?: boolean | undefined;
  }
  interface FastifyReply {
    setIdempotencyStatus(status: 'HIT' | 'MISS', replayedAt?: Date | string): FastifyReply;
  }
}

const ietfHeadersPluginAsync: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  // Decorate FastifyReply with helper to attach standardized output headers
  app.decorateReply('setIdempotencyStatus', function (status: 'HIT' | 'MISS', replayedAt?: Date | string) {
    const reply = this as FastifyReply;
    reply.header(IETF_IDEMPOTENCY_STATUS_HEADER, status);
    if (status === 'HIT') {
      const timestamp = replayedAt
        ? typeof replayedAt === 'string'
          ? replayedAt
          : replayedAt.toISOString()
        : new Date().toISOString();
      reply.header(IETF_IDEMPOTENCY_REPLAYED_AT_HEADER, timestamp);
    }
    return reply;
  });

  // Pre-handler hook to inspect and validate IETF Idempotency-Key header
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawKey = req.headers[IETF_IDEMPOTENCY_KEY_HEADER];

    if (rawKey === undefined) {
      req.isIdempotentRequest = false;
      return;
    }

    if (Array.isArray(rawKey)) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: 'Multiple Idempotency-Key headers are not permitted.',
        statusCode: 400,
        timestamp: new Date().toISOString(),
      });
    }

    const trimmedKey = rawKey.trim();
    const validation = validateIdempotencyKey(trimmedKey);

    if (!validation.valid) {
      return reply.status(400).send({
        error: 'BadRequest',
        message: validation.reason || 'Invalid Idempotency-Key header value.',
        statusCode: 400,
        timestamp: new Date().toISOString(),
      });
    }

    req.idempotencyKey = trimmedKey;
    req.isIdempotentRequest = true;
  });
};

export const ietfHeadersPlugin = fp(ietfHeadersPluginAsync, {
  name: 'ietf-idempotency-headers',
  fastify: '5.x',
});
