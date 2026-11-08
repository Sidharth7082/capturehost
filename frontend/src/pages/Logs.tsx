import { type JSX } from 'react';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { StatusPill } from '../components/StatusPill';
import { PagePlaceholder } from './PagePlaceholder';

interface AuditRow {
  id: number;
  ts: string;
  action: string;
  actor: string;
  target: string;
  success: boolean;
}

const COLUMNS: readonly Column<AuditRow>[] = [
  { key: 'ts', header: 'When', render: (row) => row.ts, muted: true },
  { key: 'action', header: 'Action', render: (row) => <span className="mono">{row.action}</span> },
  { key: 'actor', header: 'Actor', render: (row) => row.actor, hideOnMobile: true, muted: true },
  { key: 'target', header: 'Target', render: (row) => row.target, hideOnMobile: true, muted: true },
  {
    key: 'result',
    header: 'Result',
    align: 'right',
    render: (row) => (
      <StatusPill label={row.success ? 'ok' : 'failed'} tone={row.success ? 'success' : 'danger'} />
    ),
  },
];

export function Logs(): JSX.Element {
  const rows: AuditRow[] = []; // Phase 2 starts writing audit_log entries

  return (
    <PagePlaceholder
      phase={2}
      title="Audit log"
      description="Every login and privileged action, with actor, target and outcome."
    >
      <Card flush>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          getRowKey={(row) => row.id}
          caption="Audit log"
          empty={
            <EmptyState
              icon="logs"
              title="Nothing logged yet"
              description="Once authentication exists, sign-ins and container/domain actions are recorded here — never silently."
            />
          }
        />
      </Card>
    </PagePlaceholder>
  );
}
