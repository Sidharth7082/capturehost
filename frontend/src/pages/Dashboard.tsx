import { useEffect, useState, type JSX } from 'react';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { LineChart } from '../components/LineChart';
import { Skeleton } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { Tabs } from '../components/Tabs';
import { useHistory } from '../hooks/useHistory';
import { useMetrics } from '../hooks/MetricsProvider';
import type { HistoryPoint, HistoryRange } from '../api/client';
import { formatBytes, formatPercent, formatRate, formatUptime, formatClockTime } from '../utils/format';
import './Dashboard.css';

const RANGE_TABS = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
] as const;

/** How many 2s samples the stat-card sparklines keep (≈80 s of history). */
const LIVE_POINTS = 40;

export function Dashboard(): JSX.Element {
  const { snapshot, status, lastMessageAt, attempts } = useMetrics();
  const [range, setRange] = useState<HistoryRange>('1h');
  const history = useHistory(range);

  // A short live buffer for sparklines — the SQLite history is bucketed and
  // only refreshed every 30 s, which would make the cards look frozen.
  const [liveCpu, setLiveCpu] = useState<number[]>([]);
  const [liveMem, setLiveMem] = useState<number[]>([]);

  useEffect(() => {
    if (!snapshot) return;
    setLiveCpu((current) => [...current, snapshot.cpuPct].slice(-LIVE_POINTS));
    setLiveMem((current) => [...current, snapshot.memPct].slice(-LIVE_POINTS));
  }, [snapshot]);

  const points: HistoryPoint[] = history.data?.points ?? [];
  const waitingForFirstSample = snapshot === null && status !== 'offline';
  const offline = status === 'offline';

  return (
    <div className="dashboard">
      <section className="dashboard__hero" aria-label="Connection status">
        <div className="dashboard__hero-text">
          <span className="dashboard__hero-title">Machine telemetry</span>
          <span className="dashboard__hero-sub">
            {lastMessageAt
              ? `Last sample ${formatClockTime(lastMessageAt, true)} · every 2 s`
              : 'Waiting for the first sample from the backend'}
          </span>
        </div>
        <ConnectionBadge status={status} attempts={attempts} />
      </section>

      {offline && (
        <Card>
          <EmptyState
            variant="error"
            title="Lost connection to the backend"
            description="The WebSocket channel is closed. Is the backend still running on 127.0.0.1:8787? Reconnection is automatic."
          />
        </Card>
      )}

      {/* ---- row 1: four headline numbers ---- */}
      <div className="dashboard__grid">
        <StatCard
          icon="cpu"
          label="CPU"
          value={snapshot ? formatPercent(snapshot.cpuPct, 1).replace('%', '') : '—'}
          unit="%"
          percent={snapshot?.cpuPct}
          spark={liveCpu}
          sparkMax={100}
          hint={snapshot ? `${liveCpu.length} samples live` : 'no data yet'}
          loading={waitingForFirstSample}
        />
        <StatCard
          icon="memory"
          label="Memory"
          value={snapshot ? formatPercent(snapshot.memPct, 1).replace('%', '') : '—'}
          unit="%"
          percent={snapshot?.memPct}
          spark={liveMem}
          sparkMax={100}
          hint={
            snapshot
              ? `${formatBytes(snapshot.memUsedBytes)} of ${formatBytes(snapshot.memTotalBytes)}`
              : 'no data yet'
          }
          loading={waitingForFirstSample}
        />
        <StatCard
          icon="disk"
          label="Disk"
          value={snapshot ? formatPercent(snapshot.diskPct, 1).replace('%', '') : '—'}
          unit="%"
          percent={snapshot?.diskPct}
          hint={
            snapshot
              ? `${formatBytes(snapshot.diskUsedBytes)} of ${formatBytes(snapshot.diskTotalBytes)}`
              : 'no data yet'
          }
          loading={waitingForFirstSample}
        />
        <StatCard
          icon="clock"
          label="Uptime"
          value={snapshot ? formatUptime(snapshot.uptimeSeconds) : '—'}
          tone="info"
          hint="since last boot"
          loading={waitingForFirstSample}
        />
      </div>

      {/* ---- row 2: network + GPU ---- */}
      <div className="dashboard__grid dashboard__grid--two">
        <Card
          title="Network"
          subtitle="All physical interfaces, loopback excluded"
          actions={<Icon name="network" size={16} />}
        >
          {waitingForFirstSample ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <Skeleton height="18px" />
              <Skeleton height="18px" />
            </div>
          ) : (
            <>
              <div className="dashboard__stat-row">
                <span className="dashboard__stat-label">
                  <Icon name="network" size={14} />
                  Down
                </span>
                <span className="dashboard__stat-value">{snapshot ? formatRate(snapshot.netRxBps) : '—'}</span>
              </div>
              <div className="dashboard__stat-row">
                <span className="dashboard__stat-label">
                  <Icon name="network" size={14} />
                  Up
                </span>
                <span className="dashboard__stat-value">{snapshot ? formatRate(snapshot.netTxBps) : '—'}</span>
              </div>
            </>
          )}
        </Card>

        <Card title="GPU" subtitle="via nvidia-smi" actions={<Icon name="gpu" size={16} />}>
          {waitingForFirstSample ? (
            <Skeleton height="52px" />
          ) : snapshot?.gpuUtilPct === null || snapshot === null ? (
            <EmptyState
              icon="gpu"
              title="No GPU detected"
              description="nvidia-smi is not available on this host. Everything else keeps working — GPU panels stay hidden."
            />
          ) : (
            <>
              <div className="dashboard__gpu-head">
                <span className="dashboard__stat-value" style={{ fontSize: 22 }}>
                  {formatPercent(snapshot.gpuUtilPct ?? 0, 0)}
                </span>
                <span className="dashboard__stat-label">utilisation</span>
              </div>
              <div className="dashboard__stat-row">
                <span className="dashboard__stat-label">VRAM</span>
                <span className="dashboard__stat-value">
                  {snapshot.gpuMemUsedMb ?? 0} / {snapshot.gpuMemTotalMb ?? 0} MB
                </span>
              </div>
              <div className="dashboard__stat-row">
                <span className="dashboard__stat-label">Temperature</span>
                <span className="dashboard__stat-value">
                  {snapshot.gpuTempC === null ? 'n/a' : `${snapshot.gpuTempC} °C`}
                </span>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* ---- row 3: history panels ---- */}
      <div className="dashboard__panels">
        <Card
          title="CPU & memory"
          subtitle={history.data ? `Bucketed every ${history.data.bucketSeconds}s` : 'Rolling history from SQLite'}
          actions={<Tabs items={RANGE_TABS} value={range} onChange={setRange} label="History range" />}
        >
          {history.status === 'loading' && points.length === 0 ? (
            <Skeleton height="220px" />
          ) : history.status === 'error' ? (
            <EmptyState
              variant="error"
              title="Could not load history"
              description={history.error ?? 'The history endpoint did not respond.'}
            />
          ) : points.length === 0 ? (
            <EmptyState
              icon="clock"
              title="No history yet"
              description="Samples are written every 2 seconds. Give it a minute and this chart fills in."
            />
          ) : (
            <LineChart
              data={points}
              x={(point) => point.bucketTs}
              max={100}
              formatValue={(value) => `${value.toFixed(0)}%`}
              ariaLabel="CPU and memory usage over the selected range"
              series={[
                { key: 'cpu', label: 'CPU', color: 'var(--series-cpu)', accessor: (point) => point.cpuPct },
                { key: 'mem', label: 'Memory', color: 'var(--series-mem)', accessor: (point) => point.memPct },
              ]}
            />
          )}
        </Card>

        <Card title="Network history" subtitle="Receive and transmit rate">
          {history.status === 'loading' && points.length === 0 ? (
            <Skeleton height="220px" />
          ) : history.status === 'error' ? (
            <EmptyState variant="error" title="Could not load history" description={history.error ?? undefined} />
          ) : points.length === 0 ? (
            <EmptyState icon="network" title="No network history yet" />
          ) : (
            <LineChart
              data={points}
              x={(point) => point.bucketTs}
              formatValue={(value) => formatRate(value)}
              height={220}
              ariaLabel="Network receive and transmit rate over the selected range"
              series={[
                { key: 'rx', label: 'Down', color: 'var(--series-rx)', accessor: (point) => point.netRxBps },
                { key: 'tx', label: 'Up', color: 'var(--series-tx)', accessor: (point) => point.netTxBps },
              ]}
            />
          )}
        </Card>
      </div>

      {history.data?.truncated && (
        <p className="dashboard__hero-sub">
          Showing the most recent {history.data.points.length} buckets — pick a wider range or coarser bucket for
          older data.
        </p>
      )}
    </div>
  );
}
