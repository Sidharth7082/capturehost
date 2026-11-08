import { type JSX } from 'react';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { StatusPill, toneForStatus } from '../components/StatusPill';
import { PagePlaceholder } from './PagePlaceholder';

interface DomainRow {
  id: number;
  hostname: string;
  project: string;
  tls: 'active' | 'pending' | 'error';
  addedAt: string;
}

const COLUMNS: readonly Column<DomainRow>[] = [
  {
    key: 'hostname',
    header: 'Hostname',
    render: (row) => (
      <span className="cell-primary">
        <span className="cell-primary__name">{row.hostname}</span>
        <span className="cell-primary__meta">{row.project}</span>
      </span>
    ),
  },
  {
    key: 'tls',
    header: 'HTTPS',
    render: (row) => <StatusPill label={row.tls} tone={toneForStatus(row.tls)} />,
  },
  { key: 'added', header: 'Added', align: 'right', render: (row) => row.addedAt, muted: true, hideOnMobile: true },
];

export function Domains(): JSX.Element {
  const rows: DomainRow[] = []; // Phase 5 fills this from Caddy + /api/domains

  return (
    <PagePlaceholder
      phase={5}
      title="Domains"
      description="Subdomains per project, with certificates issued and renewed by Caddy."
      toolbar={
        <div className="page-toolbar">
          <span className="page-toolbar__spacer" />
        </div>
      }
    >
      <Card flush>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          getRowKey={(row) => row.id}
          caption="Project domains"
          empty={
            <EmptyState
              icon="domains"
              title="No domains attached"
              description="Point a DNS record at this host, add the subdomain here, and Caddy will obtain a certificate automatically."
            />
          }
        />
      </Card>
    </PagePlaceholder>
  );
}
