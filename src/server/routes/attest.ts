/**
 * Public Verification Endpoint & Receipt Validator (`POST /v1/attest/verify`)
 * Standalone cryptographic attestation verification route for third-party auditors and reconcilers.
 * Validates authenticity of response receipts without exposing internal databases or secret keys.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AttestationReceiptSigner } from '../../security/attest.js';

export interface VerifyReceiptBody {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly statusCode: number;
  readonly attestationHeader: string;
  readonly tenantId?: string | undefined;
}

export interface AttestVerifyRouteOptions {
  readonly attestationSigner?: AttestationReceiptSigner | undefined;
}

export const attestVerifyRoutesPlugin: FastifyPluginAsync<AttestVerifyRouteOptions> = async (
  app,
  opts
): Promise<void> => {
  const signer = opts.attestationSigner ?? (app as any).attestationSigner;

  app.post(
    '/v1/attest/verify',
    async (
      req: FastifyRequest<{
        Body: VerifyReceiptBody;
      }>,
      reply: FastifyReply
    ) => {
      const body = req.body;

      if (!body) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Request body is required.',
        });
      }

      const { idempotencyKey, fingerprint, statusCode, attestationHeader, tenantId } = body;

      if (!idempotencyKey || typeof idempotencyKey !== 'string') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing or invalid required field: idempotencyKey.',
        });
      }

      if (fingerprint === undefined || typeof fingerprint !== 'string') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing or invalid required field: fingerprint.',
        });
      }

      if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing or invalid required field: statusCode.',
        });
      }

      if (!attestationHeader || typeof attestationHeader !== 'string') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing or invalid required field: attestationHeader.',
        });
      }

      if (!signer) {
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Attestation verification engine is not configured on this server.',
        });
      }

      const tenant = tenantId || (req.headers['x-client-id'] as string) || (req.headers['x-tenant-id'] as string) || 'default_tenant';

      // Parse timestamp from header to report issuedAt
      const parts = attestationHeader.split(';');
      let issuedAtTimestamp = 0;
      for (const part of parts) {
        const [k, v] = part.split('=');
        if (k?.trim().toLowerCase() === 'ts' && v) {
          issuedAtTimestamp = parseInt(v.trim(), 10);
          break;
        }
      }

      const isValid = signer.verify(
        {
          tenantId: tenant,
          key: idempotencyKey,
          fingerprint,
          statusCode,
          timestamp: issuedAtTimestamp,
        },
        attestationHeader
      );

      if (!isValid) {
        return reply.status(200).send({
          valid: false,
          error: 'SignatureMismatch',
          message: 'Attestation receipt signature is invalid or payload has been tampered with.',
        });
      }

      return reply.status(200).send({
        valid: true,
        issuedAt: new Date(issuedAtTimestamp).toISOString(),
        keyOwner: tenant,
        statusCode,
      });
    }
  );
};

export const attestVerifyRoutes = fp(attestVerifyRoutesPlugin, {
  name: 'attest-verify-routes',
  fastify: '5.x',
});
