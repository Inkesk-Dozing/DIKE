/**
 * Redis Connection Manager & Pool Topology Orchestrator for DIKE
 * Manages standalone, Sentinel high-availability, and Redis Cluster instances with exponential jittered backoff.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { Redis, Cluster, RedisOptions, ClusterOptions } from 'ioredis';

export type RedisDeploymentMode = 'standalone' | 'sentinel' | 'cluster';

export interface SentinelNode {
  readonly host: string;
  readonly port: number;
}

export interface RedisPoolConfig {
  readonly mode?: RedisDeploymentMode | undefined;
  readonly url?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  readonly db?: number | undefined;
  readonly keyPrefix?: string | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly maxRetriesPerRequest?: number | null | undefined;
  // Sentinel specific
  readonly sentinelMasterName?: string | undefined;
  readonly sentinels?: SentinelNode[] | undefined;
  // Cluster specific
  readonly clusterNodes?: Array<{ host: string; port: number }> | undefined;
}

/**
 * Generates an exponential backoff delay with randomized full jitter.
 * Formula: min(maxDelayMs, baseDelayMs * 2^attempt) * random(0.5, 1.5)
 */
export function calculateJitteredBackoff(
  attempt: number,
  baseDelayMs = 50,
  maxDelayMs = 2000
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const jitterFactor = 0.5 + Math.random(); // Range: 0.5 to 1.5
  return Math.floor(exponential * jitterFactor);
}

/**
 * Builds standard Redis slot hash tagged key: `{tenantId}:{key}`
 * Ensures related keys map to the exact same hash slot in Redis Cluster topologies.
 */
export function formatClusterHashTag(tenantId: string, key: string, suffix?: string): string {
  const base = `{${tenantId}:${key}}`;
  return suffix ? `${base}:${suffix}` : base;
}

export class RedisConnectionManager {
  private client: Redis | Cluster | null = null;
  private readonly config: RedisPoolConfig;
  private isClosed = false;

  constructor(config: RedisPoolConfig = {}) {
    this.config = config;
  }

  /**
   * Initializes and connects client based on configured deployment mode.
   */
  public async getClient(): Promise<Redis | Cluster> {
    if (this.client && !this.isClosed) {
      return this.client;
    }

    const mode = this.config.mode ?? this.detectMode();

    if (mode === 'cluster') {
      this.client = this.createClusterClient();
    } else if (mode === 'sentinel') {
      this.client = this.createSentinelClient();
    } else {
      this.client = this.createStandaloneClient();
    }

    this.isClosed = false;
    return this.client;
  }

  private detectMode(): RedisDeploymentMode {
    if (this.config.sentinels && this.config.sentinels.length > 0) {
      return 'sentinel';
    }
    if (this.config.clusterNodes && this.config.clusterNodes.length > 0) {
      return 'cluster';
    }
    return 'standalone';
  }

  private createStandaloneClient(): Redis {
    const retryStrategy = (times: number): number => {
      return calculateJitteredBackoff(times);
    };

    const redisOptions: RedisOptions = {
      connectTimeout: this.config.connectTimeoutMs ?? 5000,
      lazyConnect: true,
      maxRetriesPerRequest: this.config.maxRetriesPerRequest ?? 3,
      retryStrategy,
      keyPrefix: this.config.keyPrefix,
    };

    if (this.config.url) {
      return new Redis(this.config.url, redisOptions);
    }

    return new Redis({
      ...redisOptions,
      host: this.config.host ?? '127.0.0.1',
      port: this.config.port ?? 6379,
      username: this.config.username,
      password: this.config.password,
      db: this.config.db ?? 0,
    });
  }

  private createSentinelClient(): Redis {
    const retryStrategy = (times: number): number => {
      return calculateJitteredBackoff(times);
    };

    const redisOptions: RedisOptions = {
      name: this.config.sentinelMasterName ?? 'mymaster',
      sentinels: this.config.sentinels ?? [{ host: '127.0.0.1', port: 26379 }],
      password: this.config.password,
      username: this.config.username,
      db: this.config.db ?? 0,
      connectTimeout: this.config.connectTimeoutMs ?? 5000,
      lazyConnect: true,
      maxRetriesPerRequest: this.config.maxRetriesPerRequest ?? 3,
      retryStrategy,
      keyPrefix: this.config.keyPrefix,
    };

    return new Redis(redisOptions);
  }

  private createClusterClient(): Cluster {
    const clusterRetryStrategy = (times: number): number => {
      return calculateJitteredBackoff(times);
    };

    const clusterOptions: ClusterOptions = {
      clusterRetryStrategy,
      lazyConnect: true,
      redisOptions: {
        connectTimeout: this.config.connectTimeoutMs ?? 5000,
        maxRetriesPerRequest: this.config.maxRetriesPerRequest ?? 3,
        password: this.config.password,
      },
    };

    const nodes = this.config.clusterNodes ?? [{ host: '127.0.0.1', port: 7000 }];
    return new Cluster(nodes, clusterOptions);
  }

  /**
   * Performs an active health check ping against Redis tier.
   */
  public async healthCheck(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const pong = await client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Gracefully drains connection pools and terminates sockets.
   */
  public async close(): Promise<void> {
    this.isClosed = true;
    if (this.client) {
      await this.client.quit().catch(() => {
        this.client?.disconnect();
      });
      this.client = null;
    }
  }
}
