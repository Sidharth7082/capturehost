import { useMemo, useState, type JSX } from 'react';
import {
  ApiError,
  containerAction,
  removeContainer,
  type ContainerState,
  type ContainerSummary,
} from '../api/client';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { Dropdown } from '../components/Dropdown';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Skeleton } from '../components/Skeleton';
import { StatusPill, toneForStatus } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { useContainers } from '../hooks/useContainers';
import { useDockerStats } from '../hooks/useDockerStats';
import { formatBytes, formatPercent, formatUptime, relativeFromNow } from '../utils/format';
import { InspectDrawer } from './containers/InspectDrawer';
import { LogsDrawer } from './containers/LogsDrawer';
import './Containers.css';

type ConfirmAction = 'stop' | 'restart' | 'remove';
type StateFilter = 'all' | 'running' | 'stopped';

const CONFIRM_COPY: Record<ConfirmAction, { title: string; body: string; label: string }> = {
  stop: {
    title: 'Stop container',
    body: 'Docker sends SIGTERM and gives the process 5 seconds before SIGKILL. Anything it was serving becomes unavailable.',
    label: 'Stop',
  },
  restart: {
    title: 'Restart container',
    body: 'The container stops and starts again with the same configuration. Expect a few seconds of downtime.',
    label: 'Restart',
  },
  remove: {
    title: 'Remove container',
    body: 'The container and its writable layer are deleted. Named volumes and the image are kept. This cannot be undone.',
    label: 'Remove',
  },
};

function uptimeLabel(container: ContainerSummary): string {
  if (container.state !== 'running' || !container.startedAt) return '—';
  return formatUptime((Date.now() - container.startedAt) / 1000);
}

function portsLabel(container: ContainerSummary): string[] {
  return container.ports.map((port) =>
    port.publicPort === null
      ? `${port.privatePort}/${port.type}`
      : `${port.publicPort}→${port.privatePort}`,
  );
}

/** Small inline usage meter: bar + value, no chart library involved. */
function Meter({ percent, label }: { percent: number; label: string }): JSX.Element {
  const tone = percent >= 85 ? 'danger' : percent >= 65 ? 'warning' : 'accent';
  return (
    <div className="meter">
      <div
        className="meter__track"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="meter__fill"
          data-tone={tone}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <span className="meter__value">{label}</span>
    </div>
  );
}

export function Containers(): JSX.Element {
  const { containers, status, unavailable, error, loading, lastUpdated, refresh } = useContainers();
  const { stats, connected } = useDockerStats(!unavailable);
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [confirm, setConfirm] = useState<{ container: ContainerSummary; action: ConfirmAction } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<ContainerSummary | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);

  // Live stats win over the REST snapshot; a stats outage keeps the snapshot.
  const merged = useMemo(
    () =>
      containers.map((container) => {
        const live = stats.get(container.id);
        return live ? { ...container, stats: live } : container;
      }),
    [containers, stats],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return merged.filter((container) => {
      const matchesState =
        stateFilter === 'all' ||
        (stateFilter === 'running' && container.state === 'running') ||
        (stateFilter === 'stopped' && container.state !== 'running');

      const matchesSearch =
        needle === '' ||
        container.name.toLowerCase().includes(needle) ||
        container.image.toLowerCase().includes(needle) ||
        container.shortId.startsWith(needle);

      return matchesState && matchesSearch;
    });
  }, [merged, search, stateFilter]);

  const openConfirm = (container: ContainerSummary, action: ConfirmAction): void => {
    setConfirm({ container, action });
    setConfirmText('');
  };

  const runAction = async (): Promise<void> => {
    if (!confirm) return;
    const { container, action } = confirm;

    setBusyId(container.id);
    try {
      if (action === 'remove') {
        await removeContainer(container.id);
        toast.push('Container removed', { message: container.name, tone: 'success' });
      } else {
        await containerAction(container.id, action);
        toast.push(`Container ${action === 'stop' ? 'stopped' : 'restarted'}`, {
          message: container.name,
          tone: 'success',
        });
      }
      setConfirm(null);
      await refresh();
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Docker rejected the request';
      toast.push('Action failed', { message, tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const startContainer = async (container: ContainerSummary): Promise<void> => {
    setBusyId(container.id);
    try {
      await containerAction(container.id, 'start');
      toast.push('Container started', { message: container.name, tone: 'success' });
      await refresh();
    } catch (caught) {
      toast.push('Could not start', {
        message: caught instanceof ApiError ? caught.message : 'Docker rejected the request',
        tone: 'danger',
      });
    } finally {
      setBusyId(null);
    }
  };

  const columns: readonly Column<ContainerSummary>[] = [
    {
      key: 'name',
      header: 'Container',
      render: (row) => (
        <div className="container-name">
          {row.protected && (
            <span className="lock-badge" title={row.protectedReason ?? 'protected'}>
              <Icon name="info" size={11} />
            </span>
          )}
          <span className="cell-primary">
            <span className="container-name__text">{row.name}</span>
            <span className="container-name__meta">{row.image}</span>
          </span>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'Status',
      render: (row) => (
        <div className="status-cell">
          <StatusPill label={row.state} tone={toneForStatus(row.state)} />
          <span className="status-cell__text">{row.statusText}</span>
        </div>
      ),
    },
    {
      key: 'ports',
      header: 'Ports',
      hideOnMobile: true,
      render: (row) => (
        <div className="container-ports">
          {portsLabel(row).length === 0 ? '—' : portsLabel(row).map((port) => <span key={port}>{port}</span>)}
        </div>
      ),
    },
    {
      key: 'uptime',
      header: 'Uptime',
      hideOnMobile: true,
      align: 'right',
      render: (row) => <span className="tabular">{uptimeLabel(row)}</span>,
    },
    {
      key: 'cpu',
      header: 'CPU',
      hideOnMobile: true,
      align: 'right',
      render: (row) =>
        row.state === 'running' && row.stats ? (
          <Meter percent={row.stats.cpuPct} label={formatPercent(row.stats.cpuPct, 1)} />
        ) : (
          <span className="meter__value">—</span>
        ),
    },
    {
      key: 'memory',
      header: 'Memory',
      hideOnMobile: true,
      align: 'right',
      render: (row) =>
        row.state === 'running' && row.stats ? (
          <Meter percent={row.stats.memPct} label={formatBytes(row.stats.memUsedBytes)} />
        ) : (
          <span className="meter__value">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => {
        const running = row.state === 'running';
        const stopped = row.state === 'exited' || row.state === 'created';

        return (
          <Dropdown
            trigger="more"
            triggerLabel={`Actions for ${row.name}`}
            items={[
              {
                key: 'start',
                label: 'Start',
                icon: 'check',
                disabled: !stopped,
                onSelect: () => void startContainer(row),
              },
              {
                key: 'stop',
                label: 'Stop',
                icon: 'close',
                disabled: !running || row.protected,
                onSelect: () => openConfirm(row, 'stop'),
              },
              {
                key: 'restart',
                label: 'Restart',
                icon: 'refresh',
                disabled: !running || row.protected,
                onSelect: () => openConfirm(row, 'restart'),
              },
              { key: 'logs', label: 'View logs', icon: 'logs', onSelect: () => setLogsFor(row) },
              { key: 'inspect', label: 'Inspect', icon: 'projects', onSelect: () => setInspectId(row.id) },
              {
                key: 'remove',
                label: 'Remove',
                icon: 'close',
                danger: true,
                dividerBefore: true,
                disabled: running || row.protected,
                onSelect: () => openConfirm(row, 'remove'),
              },
            ]}
          />
        );
      },
    },
  ];

  const runningCount = merged.filter((container) => container.state === 'running').length;

  return (
    <div className="containers-page">
      {unavailable && (
        <div className="docker-banner" role="alert">
          <Icon name="alert" size={16} />
          <div className="docker-banner__text">
            <span className="docker-banner__title">Docker unavailable</span>
            <span className="docker-banner__body">
              {error ?? 'The socket proxy is not reachable.'} Everything else on the dashboard keeps working.
            </span>
            <code className="docker-banner__command">docker compose -f docker-compose.dev.yml up -d</code>
          </div>
        </div>
      )}

      <Card flush>
        <div className="page-toolbar" style={{ padding: '12px 16px', marginBottom: 0 }}>
          <label className="page-toolbar__search">
            <Icon name="search" size={15} />
            <input
              type="search"
              placeholder="Search name, image or id…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search containers"
            />
          </label>

          <select
            className="page-toolbar__select"
            value={stateFilter}
            onChange={(event) => setStateFilter(event.target.value as StateFilter)}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="running">Running</option>
            <option value="stopped">Not running</option>
          </select>

          <span className="page-toolbar__spacer" />

          <span className="logs-toolbar__meta">
            {runningCount} running · engine {status?.version ?? '—'}
            {lastUpdated ? ` · ${relativeFromNow(lastUpdated)}` : ''}
          </span>

          <Button
            size="sm"
            icon={<Icon name="refresh" size={14} />}
            onClick={() => void refresh()}
            disabled={loading}
          >
            Refresh
          </Button>
        </div>

        {loading && containers.length === 0 ? (
          <div style={{ padding: 16, display: 'grid', gap: 8 }}>
            <Skeleton height="16px" />
            <Skeleton height="16px" />
            <Skeleton height="16px" />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={filtered}
            getRowKey={(row) => row.id}
            caption="Docker containers"
            empty={
              containers.length === 0 ? (
                <EmptyState
                  icon="containers"
                  title="No containers yet"
                  description="Start the socket proxy, or deploy a project — containers will appear here with live CPU and memory."
                />
              ) : (
                <EmptyState
                  icon="search"
                  title="No container matches"
                  description="Try a different search or status filter."
                />
              )
            }
          />
        )}
      </Card>

      {!connected && !unavailable && containers.length > 0 && (
        <p className="logs-toolbar__meta" role="status">
          Live stats disconnected — the table still refreshes every 10s.
        </p>
      )}

      <Modal
        open={confirm !== null}
        title={confirm ? CONFIRM_COPY[confirm.action].title : ''}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant={confirm?.action === 'remove' ? 'danger' : 'primary'}
              disabled={
                busyId !== null ||
                (confirm?.action === 'remove' &&
                  confirmText.trim().toLowerCase() !== confirm.container.name.toLowerCase())
              }
              onClick={() => void runAction()}
            >
              {busyId !== null ? 'Working…' : (confirm ? CONFIRM_COPY[confirm.action].label : 'Confirm')}
            </Button>
          </>
        }
      >
        {confirm && (
          <>
            <p className="confirm-text">
              <strong>{confirm.container.name}</strong> — {CONFIRM_COPY[confirm.action].body}
            </p>

            {confirm.action === 'remove' && (
              <>
                <p className="confirm-text" style={{ marginTop: 12 }}>
                  Type the container name to confirm:
                </p>
                <div className="form-field" style={{ marginTop: 8 }}>
                  <label htmlFor="confirm-name" className="visually-hidden">
                    Container name
                  </label>
                  <input
                    id="confirm-name"
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    placeholder={confirm.container.name}
                    autoComplete="off"
                    aria-describedby="confirm-hint"
                  />
                  <p className="form-hint" id="confirm-hint">
                    Volumes and the image are not deleted.
                  </p>
                </div>
              </>
            )}

            {confirm.container.protected && (
              <p className="confirm-danger">
                This container is protected ({confirm.container.protectedReason}). Docker will refuse the
                request even if it reaches the button.
              </p>
            )}
          </>
        )}
      </Modal>

      <LogsDrawer container={logsFor} onClose={() => setLogsFor(null)} />
      <InspectDrawer containerId={inspectId} onClose={() => setInspectId(null)} />
    </div>
  );
}

export type { ContainerState };
