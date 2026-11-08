import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import si from 'systeminformation';
import type { Logger } from '../logger.js';
import type { NotificationService } from './notifications.js';

/**
 * Disk monitoring for the filesystems CaptureHost actually writes to.
 *
 * The old check watched `fsSize()[0]`, which is whatever the kernel lists first
 * — usually `/`, but not necessarily the disk holding the database, backups or
 * build contexts. This picks the mount that contains those paths.
 *
 * It also has hysteresis: alert at 90%, stay quiet in the 85–90% band, and only
 * report recovery below 85%. Without that, a filesystem hovering at the
 * threshold flaps one alert per cooldown window.
 */

export interface FsEntry {
  mount: string;
  use: number;
  size: number;
  used: number;
}

export type FsProbe = () => Promise<FsEntry[]>;

const defaultProbe: FsProbe = async () =>
  (await si.fsSize()).map((entry) => ({
    mount: entry.mount,
    use: entry.use,
    size: entry.size,
    used: entry.used,
  }));

/**
 * Absolute path, with symlinks resolved only when the whole path exists.
 *
 * Walking up to the nearest existing ancestor would change the path itself and
 * break the mount matching below (a database that does not exist yet would be
 * tested as its parent directory), so the unresolved path is kept as-is.
 */
function realPathOf(path: string): string {
  const absolute = resolve(path);

  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Picks the filesystem that contains `path`: the longest mount that is a
 * prefix of it. Falls back to `/`, then to the first entry.
 */
export async function diskUsageFor(
  path: string,
  probe: FsProbe = defaultProbe,
): Promise<FsEntry & { target: string }> {
  const entries = (await probe()).filter((entry) => entry.size > 0);
  const target = realPathOf(path);

  const match = entries
    .filter((entry) => target === entry.mount || target.startsWith(entry.mount.endsWith(sep) ? entry.mount : `${entry.mount}${sep}`) || entry.mount === '/')
    .sort((a, b) => b.mount.length - a.mount.length)[0];

  const chosen = match ?? entries[0];
  if (!chosen) throw new Error('no filesystem statistics available');

  return { ...chosen, target };
}

export interface DiskAlertMonitorDeps {
  /** Paths whose filesystem should be watched (database, backups). */
  paths: string[];
  /** Alert at or above this percentage. */
  thresholdPct: number;
  /** Report recovery only below this percentage. */
  recoverPct: number;
  notifications: Pick<NotificationService, 'notify'>;
  logger: Logger;
  probe?: FsProbe;
}

export interface DiskCheckResult {
  usedPct: number;
  mount: string;
  target: string;
  state: 'ok' | 'high';
  alerted: 'high' | 'recovered' | null;
}

export class DiskAlertMonitor {
  private readonly deps: DiskAlertMonitorDeps;
  private state: 'ok' | 'high' = 'ok';

  constructor(deps: DiskAlertMonitorDeps) {
    this.deps = deps;
  }

  /** Current hysteresis state — 'high' until the disk drops below recoverPct. */
  get currentState(): 'ok' | 'high' {
    return this.state;
  }

  async check(): Promise<DiskCheckResult | null> {
    const { paths, thresholdPct, recoverPct, notifications, logger } = this.deps;

    let usage: Awaited<ReturnType<typeof diskUsageFor>>;

    try {
      // The database path is the authoritative one: backups and build
      // contexts live beside it in practice.
      usage = await diskUsageFor(paths[0] ?? '/', this.deps.probe);
    } catch (error) {
      logger.warn({ err: error }, 'disk check failed');
      return null;
    }

    const usedPct = usage.use;
    let alerted: DiskCheckResult['alerted'] = null;

    if (this.state === 'ok' && usedPct >= thresholdPct) {
      this.state = 'high';
      alerted = 'high';

      await notifications.notify({
        event: 'disk.high',
        severity: 'warning',
        title: `Disk ${usedPct.toFixed(0)}% full on ${usage.mount}`,
        body:
          `${usage.mount} (holding ${usage.target}) is above the ${thresholdPct}% threshold. ` +
          'A recovery alert follows when it drops below ' +
          `${recoverPct}%.`,
        dedupeKey: 'disk.high',
        meta: { mount: usage.mount, usedPct },
      });

      logger.warn({ mount: usage.mount, usedPct }, 'disk above threshold');
    } else if (this.state === 'high' && usedPct < recoverPct) {
      this.state = 'ok';
      alerted = 'recovered';

      await notifications.notify({
        event: 'disk.recovered',
        severity: 'info',
        title: `Disk back to ${usedPct.toFixed(0)}% on ${usage.mount}`,
        body: `${usage.mount} is below the ${recoverPct}% recovery mark again.`,
        dedupeKey: 'disk.recovered',
        meta: { mount: usage.mount, usedPct },
      });
    }

    return { usedPct, mount: usage.mount, target: usage.target, state: this.state, alerted };
  }
}
