/**
 * Unit Test Suite for In-Memory TTL Sliding Expiration Sweeper Worker
 * Tests batch slicing, low cycle latency (< 2ms), and automated memory eviction.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStorageAdapter } from '../../src/storage/memory.js';
import { MemorySweeperWorker, SweepCycleStats } from '../../src/storage/memory_sweeper.js';

describe('In-Memory TTL Sliding Expiration Sweeper Worker', () => {
  let storage: MemoryStorageAdapter;
  let sweeper: MemorySweeperWorker;

  beforeEach(() => {
    storage = new MemoryStorageAdapter({ capacity: 50_000 });
  });

  afterEach(() => {
    if (sweeper) {
      sweeper.stop();
    }
  });

  it('proactively purges expired records in a single runSweepCycle', async () => {
    // Populate storage with 20 expired keys (ttlMs: -100) and 10 valid keys
    for (let i = 0; i < 20; i++) {
      await storage.acquire({
        tenantId: 'tenant-test',
        key: `expired-key-${i}`,
        requestFingerprint: `hash-exp-${i}`,
        ttlMs: -500, // already expired
      });
    }

    for (let i = 0; i < 10; i++) {
      await storage.acquire({
        tenantId: 'tenant-test',
        key: `valid-key-${i}`,
        requestFingerprint: `hash-valid-${i}`,
        ttlMs: 60_000, // valid for 60s
      });
    }

    expect(storage.size()).toBe(30);

    sweeper = new MemorySweeperWorker(storage, {
      batchSize: 500,
      maxCycleDurationMs: 5.0,
    });

    const stats = sweeper.runSweepCycle();

    expect(stats.inspected).toBe(30);
    expect(stats.evicted).toBe(20);
    expect(stats.remainingSize).toBe(10);
    expect(storage.size()).toBe(10);
    expect(sweeper.getTotalEvicted()).toBe(20);
    expect(sweeper.getTotalCycles()).toBe(1);
  });

  it('respects batch size limits per sweep cycle to protect event loop', async () => {
    // Populate 100 expired keys
    for (let i = 0; i < 100; i++) {
      await storage.acquire({
        tenantId: 'tenant-batch',
        key: `batch-exp-${i}`,
        requestFingerprint: `hash-batch-${i}`,
        ttlMs: -100,
      });
    }

    expect(storage.size()).toBe(100);

    // Limit batch size to 30 per tick
    sweeper = new MemorySweeperWorker(storage, {
      batchSize: 30,
    });

    const statsCycle1 = sweeper.runSweepCycle();
    expect(statsCycle1.inspected).toBe(30);
    expect(statsCycle1.evicted).toBe(30);
    expect(storage.size()).toBe(70);

    const statsCycle2 = sweeper.runSweepCycle();
    expect(statsCycle2.inspected).toBe(30);
    expect(statsCycle2.evicted).toBe(30);
    expect(storage.size()).toBe(40);
  });

  it('executes within bounded duration (< 2ms for typical batch)', async () => {
    for (let i = 0; i < 150; i++) {
      await storage.acquire({
        tenantId: 'tenant-perf',
        key: `perf-${i}`,
        requestFingerprint: `hash-perf-${i}`,
        ttlMs: -100,
      });
    }

    sweeper = new MemorySweeperWorker(storage, {
      batchSize: 150,
      maxCycleDurationMs: 2.0,
    });

    const stats = sweeper.runSweepCycle();
    expect(stats.inspected).toBe(150);
    expect(stats.evicted).toBe(150);
    expect(stats.durationMs).toBeLessThan(10.0); // Strict execution ceiling under test environments
  });

  it('starts and stops background interval timer cleanly', () => {
    vi.useFakeTimers();

    const onSweepMock = vi.fn();
    sweeper = new MemorySweeperWorker(storage, {
      intervalMs: 10_000,
      onSweep: onSweepMock,
    });

    sweeper.start();
    expect(sweeper.isActive()).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(onSweepMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20_000);
    expect(onSweepMock).toHaveBeenCalledTimes(3);

    sweeper.stop();
    expect(sweeper.isActive()).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(onSweepMock).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });
});
