import { type JSX } from 'react';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { PagePlaceholder } from './PagePlaceholder';

interface DatabaseRow {
  id: number;
  file: string;
  size: string;
  backup: string;
  modified: string;
}

const COLUMNS: readonly Column<DatabaseRow>[] = [
  {
    key: 'file',
    header: 'Database',
    render: (row) => (
      <span className="cell-primary">
        <span className="cell-primary__name">{row.file}</span>
        <span className="cell-primary__meta">{row.backup}</span>
      </span>
    ),
  },
  { key: 'size', header: 'Size', align: 'right', render: (row) => row.size, hideOnMobile: true },
  { key: 'modified', header: 'Modified', align: 'right', render: (row) => row.modified, muted: true },
];

export function Databases(): JSX.Element {
  const rows: DatabaseRow[] = []; // Phase 6 fills this from the backup service

  return (
    <PagePlaceholder
      phase={6}
      title="Databases"
      description="SQLite files managed by CaptureHost, plus the backup schedule and last verified restore point."
    >
      <Card flush>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          getRowKey={(row) => row.id}
          caption="Managed databases"
          empty={
            <EmptyState
              icon="databases"
              title="No managed databases"
              description="CaptureHost keeps its own SQLite file here and will add scheduled, checksummed backups in Phase 6."
            />
          }
        />
      </Card>
    </PagePlaceholder>
  );
}
