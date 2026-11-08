import { useEffect, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { fetchAudit, type AuditEntry } from '../../api/client';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { formatClockTime } from '../../utils/format';

/** The last few audit rows, with a link to the full log. */
export function AuditSection(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;

    fetchAudit(6, 0)
      .then((page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card
      title="Recent activity"
      subtitle="Every login and privileged action"
      actions={<Link className="login-link" to="/logs">View all</Link>}
    >
      {status === 'loading' && <Skeleton height="80px" />}

      {status === 'error' && <EmptyState variant="error" title="Could not load the audit log" />}

      {status === 'ready' && entries.length === 0 && (
        <EmptyState title="Nothing recorded yet" description="Actions appear here as you use the dashboard." />
      )}

      {status === 'ready' && entries.length > 0 && (
        <div className="audit-mini">
          {entries.map((entry) => (
            <div className="audit-mini__row" key={entry.id}>
              <span className="audit-mini__dot" data-failed={entry.success === 0 ? 'true' : undefined} aria-hidden="true" />
              <span className="audit-mini__action">{entry.action}</span>
              <span className="audit-mini__meta">
                {entry.ip ?? 'local'} · {formatClockTime(entry.ts)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
