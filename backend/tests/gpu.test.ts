import { describe, expect, it } from 'vitest';
import { createGpuProbe, parseNvidiaSmiLine } from '../src/services/gpu.js';
import { collectSnapshot } from '../src/services/metrics.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('gpu probe', () => {
  it('resolves to null when nvidia-smi is not installed', async () => {
    // A machine without a GPU is a normal machine, not an error.
    const probe = createGpuProbe({ binary: '/nonexistent/nvidia-smi-capturehost-test' });
    await expect(probe()).resolves.toBeNull();
  });

  it('keeps returning null after the first failure without throwing', async () => {
    const probe = createGpuProbe({ binary: '/nonexistent/nvidia-smi-capturehost-test', unavailableTtlMs: 60_000 });
    const first = await probe();
    const second = await probe();
    expect(first).toBeNull();
    expect(second).toBeNull();
  });

  it('the sampler still produces a full snapshot without a GPU', async () => {
    const probe = createGpuProbe({ binary: '/nonexistent/nvidia-smi-capturehost-test' });
    const snapshot = await collectSnapshot(probe);

    // Real values from this machine, GPU fields explicitly absent.
    expect(snapshot.cpuPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.cpuPct).toBeLessThanOrEqual(100);
    expect(snapshot.memTotalBytes).toBeGreaterThan(0);
    expect(snapshot.memPct).toBeGreaterThan(0);
    expect(snapshot.memPct).toBeLessThanOrEqual(100);
    expect(snapshot.diskTotalBytes).toBeGreaterThan(0);
    expect(snapshot.uptimeSeconds).toBeGreaterThan(0);
    expect(snapshot.netRxBps).toBeGreaterThanOrEqual(0); // clamped, never -1
    expect(snapshot.netTxBps).toBeGreaterThanOrEqual(0);
    expect(snapshot.gpuUtilPct).toBeNull();
    expect(snapshot.gpuMemUsedMb).toBeNull();
    expect(snapshot.gpuMemTotalMb).toBeNull();
  });

  it('parses csv output from a fake nvidia-smi binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-smi-'));
    const binary = join(dir, 'nvidia-smi');
    writeFileSync(binary, '#!/bin/sh\necho "42, 1024, 4096, 55"\n', 'utf8');
    chmodSync(binary, 0o755);

    try {
      const probe = createGpuProbe({ binary });
      await expect(probe()).resolves.toEqual({
        utilPct: 42,
        memUsedMb: 1024,
        memTotalMb: 4096,
        tempC: 55,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseNvidiaSmiLine', () => {
  it('parses the documented csv shape', () => {
    expect(parseNvidiaSmiLine('12, 256, 8192, 48')).toEqual({
      utilPct: 12,
      memUsedMb: 256,
      memTotalMb: 8192,
      tempC: 48,
    });
  });

  it('treats [N/A] temperature as null but keeps the rest', () => {
    expect(parseNvidiaSmiLine('7, 100, 4096, [N/A]')).toEqual({
      utilPct: 7,
      memUsedMb: 100,
      memTotalMb: 4096,
      tempC: null,
    });
  });

  it('rejects malformed lines instead of inventing numbers', () => {
    expect(parseNvidiaSmiLine('nope')).toBeNull();
    expect(parseNvidiaSmiLine('a, b, c')).toBeNull();
  });
});
