import { describe, expect, it } from 'vitest';
import { countSamples, insertSample, pruneOlderThan, queryHistory, type MetricsSnapshot } from '../src/db/metrics.repo.js';
import { createMemoryDb } from './helpers.js';

function sample(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    ts: 0,
    cpuPct: 10,
    memUsedBytes: 100,
    memTotalBytes: 1000,
    memPct: 10,
    diskUsedBytes: 500,
    diskTotalBytes: 1000,
    diskPct: 50,
    netRxBps: 0,
    netTxBps: 0,
    gpuUtilPct: null,
    gpuMemUsedMb: null,
    gpuMemTotalMb: null,
    gpuTempC: null,
    uptimeSeconds: 1,
    ...overrides,
  };
}

const MINUTE = 60_000;

describe('metrics repository', () => {
  it('stores and reads back a sample', () => {
    const db = createMemoryDb();
    insertSample(db, sample({ ts: 1000, cpuPct: 42.5 }));
    expect(countSamples(db)).toBe(1);
  });

  it('averages samples inside the same bucket', () => {
    const db = createMemoryDb();
    // Three samples inside one 60 s bucket starting at t=0.
    insertSample(db, sample({ ts: 1_000, cpuPct: 10, memPct: 20 }));
    insertSample(db, sample({ ts: 30_000, cpuPct: 20, memPct: 40 }));
    insertSample(db, sample({ ts: 59_000, cpuPct: 30, memPct: 60 }));

    const points = queryHistory(db, { fromTs: 0, bucketSeconds: 60, limit: 720 });

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ bucketTs: 0, cpuPct: 20, memPct: 40 });
  });

  it('separates adjacent buckets and orders them ascending', () => {
    const db = createMemoryDb();
    insertSample(db, sample({ ts: 0, cpuPct: 5 }));
    insertSample(db, sample({ ts: MINUTE, cpuPct: 50 }));
    insertSample(db, sample({ ts: 2 * MINUTE, cpuPct: 95 }));

    const points = queryHistory(db, { fromTs: 0, bucketSeconds: 60, limit: 720 });

    expect(points.map((p) => p.bucketTs)).toEqual([0, MINUTE, 2 * MINUTE]);
    expect(points.map((p) => p.cpuPct)).toEqual([5, 50, 95]);
  });

  it('honours the row cap by keeping the newest buckets', () => {
    const db = createMemoryDb();
    for (let i = 0; i < 10; i += 1) {
      insertSample(db, sample({ ts: i * MINUTE, cpuPct: i }));
    }

    const points = queryHistory(db, { fromTs: 0, bucketSeconds: 60, limit: 3 });

    expect(points).toHaveLength(3);
    expect(points.map((p) => p.cpuPct)).toEqual([7, 8, 9]); // newest three, ascending
  });

  it('ignores samples older than fromTs', () => {
    const db = createMemoryDb();
    insertSample(db, sample({ ts: 0, cpuPct: 1 }));
    insertSample(db, sample({ ts: 10 * MINUTE, cpuPct: 2 }));

    const points = queryHistory(db, { fromTs: 5 * MINUTE, bucketSeconds: 60, limit: 720 });
    expect(points.map((p) => p.cpuPct)).toEqual([2]);
  });

  it('keeps GPU null when there is no GPU', () => {
    const db = createMemoryDb();
    insertSample(db, sample({ ts: 0 }));
    const points = queryHistory(db, { fromTs: 0, bucketSeconds: 60, limit: 720 });
    expect(points[0]?.gpuUtilPct).toBeNull();
  });

  it('prunes rows older than the cutoff and reports the count', () => {
    const db = createMemoryDb();
    insertSample(db, sample({ ts: 1_000 }));
    insertSample(db, sample({ ts: 2_000 }));
    insertSample(db, sample({ ts: 10 * MINUTE }));

    const removed = pruneOlderThan(db, 5 * MINUTE);

    expect(removed).toBe(2);
    expect(countSamples(db)).toBe(1);
  });

  it('pruning an empty window removes nothing', () => {
    const db = createMemoryDb();
    insertSample(db, sample({ ts: 10 * MINUTE }));
    expect(pruneOlderThan(db, 0)).toBe(0);
  });
});
