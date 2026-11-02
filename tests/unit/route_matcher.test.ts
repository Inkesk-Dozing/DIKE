import { describe, it, expect } from 'vitest';
import { RouteMatcher } from '../../src/proxy/matcher';

describe('Dynamic Route Matching & Regex Path Exclusion Engine (#67)', () => {
  it('correctly matches exact path exclusions and bypasses them', () => {
    const matcher = new RouteMatcher({
      excludes: ['/healthz', '/livez', '/readyz', '/metrics'],
    });

    expect(matcher.evaluate('/healthz')).toBe('BYPASS');
    expect(matcher.evaluate('/livez')).toBe('BYPASS');
    expect(matcher.evaluate('/readyz')).toBe('BYPASS');
    expect(matcher.evaluate('/metrics')).toBe('BYPASS');

    expect(matcher.evaluate('/v1/payments')).toBe('INTERCEPT');
    expect(matcher.evaluate('/v1/orders/create')).toBe('INTERCEPT');
  });

  it('correctly matches wildcard and glob prefix exclusions', () => {
    const matcher = new RouteMatcher({
      excludes: ['/public/**', '/static/*', '/v1/users/*/avatar'],
    });

    expect(matcher.evaluate('/public')).toBe('BYPASS');
    expect(matcher.evaluate('/public/info')).toBe('BYPASS');
    expect(matcher.evaluate('/public/docs/api')).toBe('BYPASS');

    expect(matcher.evaluate('/static/logo.png')).toBe('BYPASS');
    expect(matcher.evaluate('/static/css/main.css')).toBe('INTERCEPT'); // single * does not cross /

    expect(matcher.evaluate('/v1/users/123/avatar')).toBe('BYPASS');
    expect(matcher.evaluate('/v1/users/123/profile')).toBe('INTERCEPT');
  });

  it('correctly enforces inclusions when explicit include list is configured', () => {
    const matcher = new RouteMatcher({
      includes: ['/v1/payments/**', '/v1/charges/**'],
      excludes: ['/v1/payments/health'],
    });

    // Matches include and does not match exclude -> INTERCEPT
    expect(matcher.evaluate('/v1/payments/charge')).toBe('INTERCEPT');
    expect(matcher.evaluate('/v1/payments/refund')).toBe('INTERCEPT');
    expect(matcher.evaluate('/v1/charges/capture')).toBe('INTERCEPT');

    // Matches exclude even though prefix is under include -> BYPASS
    expect(matcher.evaluate('/v1/payments/health')).toBe('BYPASS');

    // Outside include list -> BYPASS
    expect(matcher.evaluate('/v1/auth/login')).toBe('BYPASS');
    expect(matcher.evaluate('/metrics')).toBe('BYPASS');
  });

  it('evaluates path exclusion decisions in sub-microsecond latency (< 100ns per eval on average)', () => {
    const matcher = new RouteMatcher({
      includes: ['/v1/payments/**', '/v1/orders/**'],
      excludes: ['/healthz', '/livez', '/metrics', '/public/**', '/v1/payments/health'],
    });

    const testPaths = [
      '/healthz',
      '/v1/payments/charge',
      '/public/assets/bundle.js',
      '/v1/orders/create',
      '/v1/payments/health',
      '/metrics',
      '/untracked/route',
    ];

    // Warm-up JIT and decision cache
    for (let i = 0; i < 20_000; i++) {
      matcher.evaluate(testPaths[i % testPaths.length]!);
    }

    const iterations = 500_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      matcher.evaluate(testPaths[i % testPaths.length]!);
    }
    const elapsedMs = performance.now() - start;
    const nsPerOp = (elapsedMs * 1_000_000) / iterations;

    // Acceptance criterion: < 100ns (hot cache evaluation is ~20-60ns)
    expect(nsPerOp).toBeLessThan(100);
  });
});
