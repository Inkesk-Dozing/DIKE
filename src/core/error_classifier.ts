/**
 * Error Status Code Handling & Non-Idempotent Failure Classification for DIKE
 * Evaluates HTTP status codes and transport errors to determine whether an outcome
 * is a permanent deterministic response (to be resolved and cached) or a transient failure
 * (to be aborted and evicted, allowing immediate client retry).
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

export type ErrorClassification = 'PERMANENT' | 'TRANSIENT';

export interface ClassificationDecision {
  readonly classification: ErrorClassification;
  readonly isCacheable: boolean;
  readonly shouldReleaseLease: boolean;
  readonly reason: string;
}

export interface ErrorClassifierOptions {
  /**
   * Additional HTTP status codes to classify as permanent/cacheable.
   */
  readonly extraPermanentStatuses?: ReadonlyArray<number> | undefined;
  /**
   * Status codes explicitly overridden as transient (e.g. rate limit 429).
   */
  readonly extraTransientStatuses?: ReadonlyArray<number> | undefined;
}

/**
 * Standard classification defaults:
 * Permanent (Cacheable): 200..299, 300..399, 400, 404, 405, 410, 422
 * Transient (Retryable): 408 (Request Timeout), 429 (Too Many Requests), 500, 502, 503, 504
 */
export class ErrorStatusClassifier {
  private readonly customPermanent: Set<number>;
  private readonly customTransient: Set<number>;

  constructor(options: ErrorClassifierOptions = {}) {
    this.customPermanent = new Set(options.extraPermanentStatuses ?? []);
    this.customTransient = new Set(options.extraTransientStatuses ?? []);
  }

  /**
   * Classifies an HTTP status code returned by an upstream service.
   */
  public classifyStatus(statusCode: number): ClassificationDecision {
    if (this.customTransient.has(statusCode)) {
      return {
        classification: 'TRANSIENT',
        isCacheable: false,
        shouldReleaseLease: true,
        reason: `Explicitly configured transient status code ${statusCode}`,
      };
    }

    if (this.customPermanent.has(statusCode)) {
      return {
        classification: 'PERMANENT',
        isCacheable: true,
        shouldReleaseLease: false,
        reason: `Explicitly configured permanent status code ${statusCode}`,
      };
    }

    // 1. Success & Redirection ranges (2xx, 3xx): Permanent / Cacheable
    if (statusCode >= 200 && statusCode < 400) {
      return {
        classification: 'PERMANENT',
        isCacheable: true,
        shouldReleaseLease: false,
        reason: `Successful or redirection status code ${statusCode}`,
      };
    }

    // 2. Client Errors (4xx)
    if (statusCode >= 400 && statusCode < 500) {
      // 408 Request Timeout and 429 Too Many Requests are transient by default
      if (statusCode === 408 || statusCode === 429) {
        return {
          classification: 'TRANSIENT',
          isCacheable: false,
          shouldReleaseLease: true,
          reason: `Transient client rate limit or timeout code ${statusCode}`,
        };
      }

      // Business client failures: 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 422 Unprocessable Entity
      return {
        classification: 'PERMANENT',
        isCacheable: true,
        shouldReleaseLease: false,
        reason: `Deterministic client error code ${statusCode}`,
      };
    }

    // 3. Server Errors (5xx): 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
    return {
      classification: 'TRANSIENT',
      isCacheable: false,
      shouldReleaseLease: true,
      reason: `Transient upstream infrastructure failure code ${statusCode}`,
    };
  }

  /**
   * Classifies thrown errors (e.g. TCP resets, timeouts, DNS failures).
   */
  public classifyError(error: any): ClassificationDecision {
    const code = error?.code || '';
    const message = error?.message || '';

    // Transient network/socket errors
    const transientCodes = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'EHOSTUNREACH',
      'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ]);

    if (transientCodes.has(code) || /timeout|reset|network|socket/i.test(message)) {
      return {
        classification: 'TRANSIENT',
        isCacheable: false,
        shouldReleaseLease: true,
        reason: `Transient network/socket failure: ${code || message}`,
      };
    }

    // Check if error has an HTTP status code attached
    if (typeof error?.statusCode === 'number') {
      return this.classifyStatus(error.statusCode);
    }

    // Default unhandled exceptions to TRANSIENT to avoid caching catastrophic bugs
    return {
      classification: 'TRANSIENT',
      isCacheable: false,
      shouldReleaseLease: true,
      reason: `Unclassified execution error: ${message}`,
    };
  }
}

export const defaultErrorClassifier = new ErrorStatusClassifier();
