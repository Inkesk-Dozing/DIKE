/**
 * OpenTelemetry Metrics & Prometheus Metric Registry for DIKE
 * Provides standard operational metrics tracking requests, cache hit/miss rates,
 * lock contention, parking durations, and active parked connections.
 * Formats outputs in Prometheus text format at `/metrics`.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

export interface MetricLabels {
  readonly [key: string]: string | number;
}

export class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: ReadonlyArray<string> = []
  ) {}

  public inc(labelsOrAmount?: MetricLabels | number, maybeAmount?: number): void {
    let labels: MetricLabels = {};
    let amount = 1;

    if (typeof labelsOrAmount === 'number') {
      amount = labelsOrAmount;
    } else if (labelsOrAmount && typeof labelsOrAmount === 'object') {
      labels = labelsOrAmount;
      if (typeof maybeAmount === 'number') {
        amount = maybeAmount;
      }
    }

    const key = this.formatKey(labels);
    const curr = this.values.get(key) ?? 0;
    this.values.set(key, curr + amount);
  }

  public get(labels: MetricLabels = {}): number {
    return this.values.get(this.formatKey(labels)) ?? 0;
  }

  public reset(): void {
    this.values.clear();
  }

  public toPrometheusString(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];

    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines.join('\n');
    }

    for (const [key, val] of this.values.entries()) {
      lines.push(key ? `${this.name}{${key}} ${val}` : `${this.name} ${val}`);
    }

    return lines.join('\n');
  }

  private formatKey(labels: MetricLabels): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `${k}="${v}"`).join(',');
  }
}

export class Gauge {
  private readonly values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: ReadonlyArray<string> = []
  ) {}

  public set(labelsOrVal: MetricLabels | number, maybeVal?: number): void {
    let labels: MetricLabels = {};
    let val = 0;

    if (typeof labelsOrVal === 'number') {
      val = labelsOrVal;
    } else if (labelsOrVal && typeof labelsOrVal === 'object') {
      labels = labelsOrVal;
      if (typeof maybeVal === 'number') {
        val = maybeVal;
      }
    }

    const key = this.formatKey(labels);
    this.values.set(key, val);
  }

  public inc(labels: MetricLabels = {}, amount = 1): void {
    const key = this.formatKey(labels);
    const curr = this.values.get(key) ?? 0;
    this.values.set(key, curr + amount);
  }

  public dec(labels: MetricLabels = {}, amount = 1): void {
    const key = this.formatKey(labels);
    const curr = this.values.get(key) ?? 0;
    this.values.set(key, curr - amount);
  }

  public get(labels: MetricLabels = {}): number {
    return this.values.get(this.formatKey(labels)) ?? 0;
  }

  public reset(): void {
    this.values.clear();
  }

  public toPrometheusString(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];

    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines.join('\n');
    }

    for (const [key, val] of this.values.entries()) {
      lines.push(key ? `${this.name}{${key}} ${val}` : `${this.name} ${val}`);
    }

    return lines.join('\n');
  }

  private formatKey(labels: MetricLabels): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `${k}="${v}"`).join(',');
  }
}

export class Histogram {
  private readonly buckets: number[];
  private count = 0;
  private sum = 0;
  private readonly bucketCounts = new Map<number, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    for (const b of this.buckets) {
      this.bucketCounts.set(b, 0);
    }
  }

  public observe(value: number): void {
    this.count++;
    this.sum += value;
    for (const b of this.buckets) {
      if (value <= b) {
        this.bucketCounts.set(b, (this.bucketCounts.get(b) ?? 0) + 1);
      }
    }
  }

  public reset(): void {
    this.count = 0;
    this.sum = 0;
    for (const b of this.buckets) {
      this.bucketCounts.set(b, 0);
    }
  }

  public toPrometheusString(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    for (const b of this.buckets) {
      const c = this.bucketCounts.get(b) ?? 0;
      lines.push(`${this.name}_bucket{le="${b}"} ${c}`);
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    lines.push(`${this.name}_count ${this.count}`);

    return lines.join('\n');
  }
}

export class PrometheusRegistry {
  public readonly requestsTotal = new Counter(
    'dike_requests_total',
    'Total HTTP requests processed by DIKE',
    ['method', 'status', 'idempotency']
  );

  public readonly cacheHitsTotal = new Counter(
    'dike_cache_hits_total',
    'Total idempotent cache hits served',
    ['tenant']
  );

  public readonly cacheMissesTotal = new Counter(
    'dike_cache_misses_total',
    'Total fresh idempotent executions (cache misses)',
    ['tenant']
  );

  public readonly parkedConnectionsActive = new Gauge(
    'dike_parked_connections_active',
    'Current active parked HTTP connections awaiting leader resolution',
    ['tenant']
  );

  public readonly mutationDurationSeconds = new Histogram(
    'dike_mutation_duration_seconds',
    'Duration of leader upstream mutation executions in seconds'
  );

  public renderMetrics(): string {
    return [
      this.requestsTotal.toPrometheusString(),
      this.cacheHitsTotal.toPrometheusString(),
      this.cacheMissesTotal.toPrometheusString(),
      this.parkedConnectionsActive.toPrometheusString(),
      this.mutationDurationSeconds.toPrometheusString(),
    ].join('\n\n') + '\n';
  }

  public resetAll(): void {
    this.requestsTotal.reset();
    this.cacheHitsTotal.reset();
    this.cacheMissesTotal.reset();
    this.parkedConnectionsActive.reset();
    this.mutationDurationSeconds.reset();
  }
}

export const defaultMetricsRegistry = new PrometheusRegistry();
