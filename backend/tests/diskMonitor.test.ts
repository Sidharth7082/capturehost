import { describe, expect, it } from 'vitest';
import { DiskAlertMonitor, diskUsageFor, type FsEntry } from '../src/services/diskMonitor.js';
import { silentLogger } from './helpers.js';

/**
 * The disk alert has to watch the filesystem that holds the data, and it has to
 * stop flapping around the threshold.
 */

const MOUNTS: FsEntry[] = [
  { mount: '/', use: 40, size: 100, used: 40 },
  { mount: '/var/lib/capturehost', use: 93, size: 900, used: 837 },
  { mount: '/boot', use: 7, size: 4, used: 0.3 },
];

const probe = async (): Promise<FsEntry[]> => MOUNTS;

function recorder() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    notify: (async (input: Record<string, unknown>) => {
      calls.push(input);
      return { stored: true, delivered: false };
    }) as never,
  };
}

describe('diskUsageFor', () => {
  it('picks the mount that contains the path, not the first one listed', async () => {
    const usage = await diskUsageFor('/var/lib/capturehost/capturehost.db', probe);

    expect(usage.mount).toBe('/var/lib/capturehost');
    expect(usage.use).toBe(93);
  });

  it('falls back to the root mount for a path outside every specific mount', async () => {
    const usage = await diskUsageFor('/home/capture/notes.txt', probe);
    expect(usage.mount).toBe('/');
  });

  it('does not match a sibling that merely shares a prefix', async () => {
    // /var/lib/capturehost2 must not be treated as inside /var/lib/capturehost.
    const usage = await diskUsageFor('/var/lib/capturehost2/x', probe);
    expect(usage.mount).toBe('/');
  });
});

describe('DiskAlertMonitor', () => {
  function monitor(uses: number[]) {
    let index = 0;
    const rec = recorder();

    const instance = new DiskAlertMonitor({
      paths: ['/var/lib/capturehost/capturehost.db'],
      thresholdPct: 90,
      recoverPct: 85,
      notifications: rec as never,
      logger: silentLogger,
      probe: async () => [
        { mount: '/', use: 20, size: 100, used: 20 },
        { mount: '/var/lib/capturehost', use: uses[Math.min(index++, uses.length - 1)]!, size: 900, used: 800 },
      ],
    });

    return { instance, rec };
  }

  it('alerts once on the way up and reports the mount', async () => {
    const { instance, rec } = monitor([93]);

    const result = await instance.check();

    expect(result?.alerted).toBe('high');
    expect(result?.mount).toBe('/var/lib/capturehost');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({ event: 'disk.high', severity: 'warning' });
    expect(String(rec.calls[0]?.title)).toContain('/var/lib/capturehost');
  });

  it('stays quiet while it hovers above the threshold', async () => {
    const { instance, rec } = monitor([93, 91, 96]);

    await instance.check();
    await instance.check();
    await instance.check();

    expect(rec.calls).toHaveLength(1);
    expect(instance.currentState).toBe('high');
  });

  it('does not call it recovered inside the hysteresis band', async () => {
    const { instance, rec } = monitor([93, 88, 86]);

    await instance.check();
    await instance.check();
    await instance.check();

    expect(rec.calls).toHaveLength(1);
    expect(instance.currentState).toBe('high');
  });

  it('reports recovery below the recovery mark, then can alert again', async () => {
    const { instance, rec } = monitor([93, 84, 95]);

    await instance.check();
    const recovered = await instance.check();
    const again = await instance.check();

    expect(recovered?.alerted).toBe('recovered');
    expect(again?.alerted).toBe('high');

    expect(rec.calls.map((call) => call.event)).toEqual(['disk.high', 'disk.recovered', 'disk.high']);
  });
});
