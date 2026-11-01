/**
 * Response Header Whitelist & Hop-by-Hop Filter Engine (RFC 7230) for DIKE
 * Strips connection-specific hop-by-hop headers from stored / replayed HTTP responses,
 * preserves application business headers, and injects fresh date / replay telemetry headers.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

/**
 * Standard RFC 7230 Section 6.1 hop-by-hop headers.
 * These headers are meaningful only for a single transport-level connection
 * and must not be stored, forwarded across proxies, or replayed from cache.
 */
export const RFC7230_HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export interface HeaderFilterOptions {
  /**
   * Additional custom header names to drop when sanitizing (case-insensitive).
   */
  readonly extraDropHeaders?: ReadonlyArray<string> | undefined;
  /**
   * Header names explicitly preserved even if matching drop rules.
   */
  readonly preservedHeaders?: ReadonlyArray<string> | undefined;
  /**
   * Whether to inject fresh 'date' header on replay. Default: true.
   */
  readonly injectFreshDate?: boolean | undefined;
  /**
   * Whether to inject 'idempotency-replayed-at' ISO timestamp header on replay. Default: true.
   */
  readonly injectReplayedAt?: boolean | undefined;
}

export class ResponseHeaderFilter {
  private readonly dropHeaders: Set<string>;
  private readonly preservedHeaders: Set<string>;
  private readonly injectFreshDate: boolean;
  private readonly injectReplayedAt: boolean;

  constructor(options: HeaderFilterOptions = {}) {
    this.dropHeaders = new Set<string>(RFC7230_HOP_BY_HOP_HEADERS);
    if (options.extraDropHeaders) {
      for (const h of options.extraDropHeaders) {
        this.dropHeaders.add(h.toLowerCase());
      }
    }

    this.preservedHeaders = new Set<string>(
      (options.preservedHeaders ?? []).map((h) => h.toLowerCase())
    );
    this.injectFreshDate = options.injectFreshDate ?? true;
    this.injectReplayedAt = options.injectReplayedAt ?? true;
  }

  /**
   * Sanitizes upstream headers before persisting to cache.
   * Strips hop-by-hop headers, but retains content headers and application metadata.
   */
  public sanitizeForStorage(
    headers: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    const clean: Record<string, string> = {};

    // Check for custom connection tokens declared in the 'Connection' header (RFC 7230 Section 6.1)
    const connectionHeader = headers['connection'] ?? headers['Connection'];
    const connectionTokens = new Set<string>();
    if (connectionHeader) {
      const tokens = Array.isArray(connectionHeader)
        ? connectionHeader.join(',').split(',')
        : String(connectionHeader).split(',');
      for (const token of tokens) {
        const trimmed = token.trim().toLowerCase();
        if (trimmed) connectionTokens.add(trimmed);
      }
    }

    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      const lower = key.toLowerCase();

      // Check preserved override
      if (this.preservedHeaders.has(lower)) {
        clean[lower] = Array.isArray(value) ? value.join(', ') : String(value);
        continue;
      }

      // Drop RFC 7230 hop-by-hop headers and connection-nominated headers
      if (this.dropHeaders.has(lower) || connectionTokens.has(lower)) {
        continue;
      }

      clean[lower] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    return clean;
  }

  /**
   * Prepares cached headers for replay to client.
   * Filters out any stale hop-by-hop headers, injects fresh Date, and adds replay timestamp.
   */
  public prepareReplayHeaders(
    storedHeaders: Record<string, string | string[] | undefined>,
    replayTimestamp = new Date()
  ): Record<string, string> {
    const headers = this.sanitizeForStorage(storedHeaders);

    if (this.injectFreshDate) {
      headers['date'] = replayTimestamp.toUTCString();
    }

    if (this.injectReplayedAt) {
      headers['idempotency-replayed-at'] = replayTimestamp.toISOString();
    }

    return headers;
  }
}
