/**
 * HTTP 304 Not Modified & ETag Co-Existence Handler for DIKE
 * Coordinates caching and replay semantics when clients present conditional validation
 * headers (If-None-Match, If-Match) alongside idempotency keys.
 * Ensures upstream HTTP 304 Not Modified empty bodies never overwrite canonical stored 200/201 payloads.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FastifyRequest } from 'fastify';
import { IIdempotencyStorage } from '../storage/interface.js';
import { IdempotencyRecord } from '../core/types.js';

export interface ETagEvaluationResult {
  /**
   * Status code to return to the client.
   */
  readonly statusCode: number;
  /**
   * Headers to return to client.
   */
  readonly headers: Record<string, string>;
  /**
   * Body to deliver to client (either existing cached payload, empty for 304, or new).
   */
  readonly body: any;
  /**
   * Body to persist into idempotency storage.
   * If upstream returns 304, this preserves the prior cached body instead of an empty buffer.
   */
  readonly bodyToPersist: any;
}

export class ETagCoexistenceHandler {
  /**
   * Evaluates upstream response in context of client conditional headers and existing storage record.
   *
   * @param upstreamStatus Status code returned by upstream server (e.g. 200, 304)
   * @param upstreamHeaders Headers returned by upstream server
   * @param upstreamBody Body returned by upstream server
   * @param existingRecord Existing record in storage, if any
   */
  public evaluateResponse(
    upstreamStatus: number,
    upstreamHeaders: Record<string, string>,
    upstreamBody: any,
    existingRecord?: IdempotencyRecord | null
  ): ETagEvaluationResult {
    // Case: Upstream responded with 304 Not Modified
    if (upstreamStatus === 304) {
      const mergedHeaders = { ...upstreamHeaders };

      // Preserve canonical ETag if existing record had one and upstream omitted it
      if (existingRecord?.responseHeaders?.['etag'] && !mergedHeaders['etag']) {
        mergedHeaders['etag'] = existingRecord.responseHeaders['etag'];
      }

      // If we have an existing cached body in storage, preserve it for persistence
      const bodyToPersist =
        existingRecord && existingRecord.responseBody !== undefined && existingRecord.responseBody !== null
          ? existingRecord.responseBody
          : upstreamBody;

      return {
        statusCode: 304,
        headers: mergedHeaders,
        body: upstreamBody, // Client receives 304 empty body per HTTP spec
        bodyToPersist,      // Storage retains the full canonical body
      };
    }

    // Normal non-304 response (200, 201, etc.)
    return {
      statusCode: upstreamStatus,
      headers: upstreamHeaders,
      body: upstreamBody,
      bodyToPersist: upstreamBody,
    };
  }

  /**
   * Checks client request headers for ETag matching against a cached record on replay.
   * If client sent `If-None-Match: "etag"` and it matches the cached record's ETag,
   * DIKE can respond with 304 Not Modified directly.
   */
  public evaluateReplayConditional(
    req: FastifyRequest,
    record: IdempotencyRecord
  ): { shouldSend304: boolean; headers: Record<string, string> } {
    const ifNoneMatch = req.headers['if-none-match'];
    const cachedEtag = record.responseHeaders?.['etag'] || record.responseHeaders?.['ETag'];

    const outHeaders: Record<string, string> = {
      ...(record.responseHeaders ?? {}),
    };

    if (ifNoneMatch && cachedEtag) {
      const clientEtags = (Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch)
        .split(',')
        .map((t) => t.trim().replace(/^W\//, '')); // normalize weak ETags

      const normalizedCached = cachedEtag.trim().replace(/^W\//, '');

      if (clientEtags.includes('*') || clientEtags.includes(normalizedCached)) {
        return {
          shouldSend304: true,
          headers: outHeaders,
        };
      }
    }

    return {
      shouldSend304: false,
      headers: outHeaders,
    };
  }
}

export const defaultETagHandler = new ETagCoexistenceHandler();
