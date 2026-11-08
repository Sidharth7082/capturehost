import { useCallback, useEffect, useState, type JSX } from 'react';
import { ApiError, fetchAudit, type AuditEntry } from '../api/client';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';
import { formatClockTime, relativeFromNow } from '../utils/format';

const PAGE_SIZE = 25;

const COLUMNS: readonly Column<AuditEntry>[] = [
  {
    key: 'ts',
    header: 'When',
    render: (row) => (
      <span className="cell-primary">
        <span className="cell-primary__name">{formatClockTime(row.ts, true)}</span>
        <span className="cell-primary__meta">{relativeFromNow(row.ts)}</span>
      </span>
    ),
  },
  { key: 'action', header: 'Action', render: (row) => <span className="mono">{row.action}</span> },
  { key: 'actor', header: 'Actor', render: (row) => row.actor, hideOnMobile: true, muted: true },
  {
    key: 'target',
    header: 'Target',
    hideOnMobile: true,
    muted: true,
    render: (row) => row.target ?? row.detail ?? '—',
  },
  {
    key: 'result',
    header: 'Result',
    align: 'right',
    hideOnMobile: true,
    render: (row) => (
      <StatusPill label={row.success === 1 ? 'ok' : 'failed'} tone={row.success === 1 ? 'success' : 'danger'} />
    ),
  },
];

/** Full audit trail with offset pagination. */
export function Logs(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextOffset: number) => {
    setStatus('loading');
    try {
      const page = await fetchAudit(PAGE_SIZE, nextOffset);
      setEntries(page.entries);
      setTotal(page.total);
      setHasMore(page.hasMore);
      setOffset(page.offset);
      setStatus('ready');
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the audit log');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <div className="page-placeholder">
      <Card
        title="Audit log"
        subtitle={`${total} record${total === 1 ? '' : 's'} · newest first`}
        flush
      >
        {status === 'loading' && (
          <div style={{ padding: 16, display: 'grid', gap: 8 }}>
            <Skeleton height="14px" />
            <Skeleton height="14px" />
            <Skeleton height="14px" />
          </div>
        )}

        {status === 'error' && (
          <EmptyState variant="error" title="Could not load the audit log" description={error ?? undefined} />
        )}

        {status === 'ready' && (
          <DataTable
            columns={COLUMNS}
            rows={entries}
            getRowKey={(row) => row.id}
            caption="Audit log entries"
            empty={
              <EmptyState
                icon="logs"
                title="Nothing logged yet"
                description="Sign-ins and privileged actions are recorded here as they happen."
              />
            }
          />
        )}
      </Card>

      {status === 'ready' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button size="sm" disabled={offset === 0} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </Button>
          <Button size="sm" disabled={!hasMore} onClick={() => void load(offset + PAGE_SIZE)}>
            Next
          </Button>
          <span className="page-placeholder__banner-sub">
            Showing {total === 0 ? 0 : offset + 1}–{offset + entries.length} of {total}
          </span>
        </div>
      )}
    </div>
  );
}
