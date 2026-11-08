import type { Db } from './connection.js';

/**
 * A single metrics observation. Mirrors one row of the `metrics` table.
 * GPU fields are nullable on purpose: absent hardware must never be
 * reported as 0 % usage.
 */
export interface MetricsSnapshot {
  ts: number;
  cpuPct: number;
  memUsedBytes: number;
  memTotalBytes: number;
  memPct: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskPct: number;
  netRxBps: number;
  netTxBps: number;
  gpuUtilPct: number | null;
  gpuMemUsedMb: number | null;
  gpuMemTotalMb: number | null;
  gpuTempC: number | null;
  uptimeSeconds: number;
}

export interface HistoryPoint {
  bucketTs: number;
  cpuPct: number;
  memPct: number;
  diskPct: number;
  netRxBps: number;
  netTxBps: number;
  gpuUtilPct: number | null;
}

export interface HistoryQuery {
  fromTs: number;
  bucketSeconds: number;
  /** Hard cap on returned buckets; the newest buckets win. */
  limit: number;
}

const INSERT_SQL = `
  INSERT INTO metrics (
    ts, cpu_pct, mem_used_bytes, mem_total_bytes, mem_pct,
    disk_used_bytes, disk_total_bytes, disk_pct, net_rx_bps, net_tx_bps,
    gpu_util_pct, gpu_mem_used_mb, gpu_mem_total_mb, gpu_temp_c, uptime_seconds
  ) VALUES (
    @ts, @cpuPct, @memUsedBytes, @memTotalBytes, @memPct,
    @diskUsedBytes, @diskTotalBytes, @diskPct, @netRxBps, @netTxBps,
    @gpuUtilPct, @gpuMemUsedMb, @gpuMemTotalMb, @gpuTempC, @uptimeSeconds
  )
`;

/**
 * Bucketed averages for the history chart.
 *
 * Rows are grouped by `floor(ts / bucket)` so the browser receives at most a
 * few hundred points instead of 43k raw samples for 24 h at 2 s.
 * The inner query takes the newest buckets first, then the outer one re-sorts
 * them ascending for a left-to-right chart.
 */
const HISTORY_SQL = `
  SELECT * FROM (
    SELECT
      CAST(ts / @bucketMs AS INTEGER) * @bucketMs AS bucket_ts,
      AVG(cpu_pct)    AS cpu_pct,
      AVG(mem_pct)    AS mem_pct,
      AVG(disk_pct)   AS disk_pct,
      AVG(net_rx_bps) AS net_rx_bps,
      AVG(net_tx_bps) AS net_tx_bps,
      AVG(gpu_util_pct) AS gpu_util_pct
    FROM metrics
    WHERE ts >= @fromTs
    GROUP BY bucket_ts
    ORDER BY bucket_ts DESC
    LIMIT @limit
  )
  ORDER BY bucket_ts ASC
`;

interface HistoryRow {
  bucket_ts: number;
  cpu_pct: number;
  mem_pct: number;
  disk_pct: number;
  net_rx_bps: number;
  net_tx_bps: number;
  gpu_util_pct: number | null;
}

export function insertSample(db: Db, sample: MetricsSnapshot): void {
  db.prepare(INSERT_SQL).run(sample);
}

export function queryHistory(db: Db, query: HistoryQuery): HistoryPoint[] {
  const rows = db.prepare(HISTORY_SQL).all({
    bucketMs: query.bucketSeconds * 1000,
    fromTs: query.fromTs,
    limit: query.limit,
  }) as HistoryRow[];

  return rows.map((row) => ({
    bucketTs: row.bucket_ts,
    cpuPct: Number(row.cpu_pct.toFixed(2)),
    memPct: Number(row.mem_pct.toFixed(2)),
    diskPct: Number(row.disk_pct.toFixed(2)),
    netRxBps: Number(row.net_rx_bps.toFixed(2)),
    netTxBps: Number(row.net_tx_bps.toFixed(2)),
    gpuUtilPct: row.gpu_util_pct === null ? null : Number(row.gpu_util_pct.toFixed(2)),
  }));
}

/** Deletes everything older than the cutoff. Returns the number of rows removed. */
export function pruneOlderThan(db: Db, cutoffTs: number): number {
  const result = db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoffTs);
  return result.changes;
}

export function countSamples(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM metrics').get() as { count: number };
  return row.count;
}
