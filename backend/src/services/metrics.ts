import si from 'systeminformation';
import type { MetricsSnapshot } from '../db/metrics.repo.js';
import type { Logger } from '../logger.js';
import type { GpuProbe } from './gpu.js';

export interface SamplerOptions {
  intervalMs: number;
  retentionHours: number;
  gpuProbe: GpuProbe;
  logger: Logger;
  /** Called with every snapshot, after the previous one finished. */
  onSample: (snapshot: MetricsSnapshot) => void;
  /** How often to delete rows older than the retention window. */
  pruneIntervalMs?: number;
}

const BYTES_TO_GB = 1024 ** 3;

function clampNonNegative(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value; // systeminformation returns -1 on its first network read
}

/** Rounds to 2 decimals so the JSON payload stays small and the UI stable. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * One raw observation of the machine.
 *
 * Individual collectors are allowed to fail: a broken sensor must not stop the
 * whole stream, so each one falls back to a safe value and the failure is
 * reported once by the caller.
 */
export async function collectSnapshot(gpuProbe: GpuProbe, now: number = Date.now()): Promise<MetricsSnapshot> {
  const [load, mem, fsSizes, netStats, gpu] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
    gpuProbe().catch(() => null),
  ]);

  // The root filesystem is what "disk full" means to a normal user.
  const rootFs = fsSizes.find((fs) => fs.mount === '/') ?? fsSizes[0];

  // Sum every physical interface; loopback traffic is not real network use.
  const netTotals = netStats
    .filter((iface) => iface.iface !== 'lo')
    .reduce(
      (acc, iface) => ({
        rx: acc.rx + clampNonNegative(iface.rx_sec),
        tx: acc.tx + clampNonNegative(iface.tx_sec),
      }),
      { rx: 0, tx: 0 },
    );

  const memTotal = mem.total > 0 ? mem.total : 1;
  const diskTotal = (rootFs?.size ?? 0) > 0 ? (rootFs?.size ?? 1) : 1;
  const diskUsed = rootFs?.used ?? 0;

  return {
    ts: now,
    cpuPct: round2(Math.min(100, Math.max(0, load.currentLoad))),
    memUsedBytes: Math.round(mem.used),
    memTotalBytes: Math.round(mem.total),
    memPct: round2(Math.min(100, (mem.used / memTotal) * 100)),
    diskUsedBytes: Math.round(diskUsed),
    diskTotalBytes: Math.round(rootFs?.size ?? 0),
    diskPct: round2(Math.min(100, (diskUsed / diskTotal) * 100)),
    netRxBps: round2(netTotals.rx),
    netTxBps: round2(netTotals.tx),
    gpuUtilPct: gpu ? round2(gpu.utilPct) : null,
    gpuMemUsedMb: gpu ? Math.round(gpu.memUsedMb) : null,
    gpuMemTotalMb: gpu ? Math.round(gpu.memTotalMb) : null,
    gpuTempC: gpu?.tempC ?? null,
    uptimeSeconds: Math.round(si.time().uptime),
  };
}

/**
 * Samples the machine on a fixed interval.
 *
 * Deliberately a singleton per process: ten open browser tabs must cost one
 * `systeminformation` read every 2 s, not ten. Subscribers are plain callbacks
 * (the WebSocket route fans out from here).
 *
 * Sampling is also non-overlapping — if a read is still running when the next
 * tick fires, that tick is skipped instead of queueing work.
 */
export class MetricsSampler {
  private readonly options: SamplerOptions;
  private readonly pruneIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private last: MetricsSnapshot | null = null;
  private consecutiveFailures = 0;

  constructor(options: SamplerOptions) {
    this.options = options;
    this.pruneIntervalMs = options.pruneIntervalMs ?? 5 * 60_000;
  }

  getLast(): MetricsSnapshot | null {
    return this.last;
  }

  /** Runs one sample immediately; used on boot so the first client has data. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const snapshot = await collectSnapshot(this.options.gpuProbe);
      this.last = snapshot;
      this.consecutiveFailures = 0;
      this.options.onSample(snapshot);
    } catch (error) {
      // Log the first failure loudly, then every tenth, so a flapping sensor
      // cannot drown the log.
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
        this.options.logger.error(
          { err: error, consecutiveFailures: this.consecutiveFailures },
          'metrics sample failed',
        );
      }
    } finally {
      this.inFlight = false;
    }
  }

  start(): void {
    if (this.timer) return;

    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.pruneTimer = setInterval(() => this.requestPrune(), this.pruneIntervalMs);

    // Do not keep the event loop alive just for the timers.
    this.timer.unref?.();
    this.pruneTimer.unref?.();
  }

  /** Set by the caller that owns the database, keeps this class storage-agnostic. */
  private onPrune: (() => void) | null = null;

  setPruneHandler(handler: () => void): void {
    this.onPrune = handler;
  }

  private requestPrune(): void {
    this.onPrune?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export { BYTES_TO_GB };
