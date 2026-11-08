import { type JSX } from 'react';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { StatusPill, toneForStatus } from '../components/StatusPill';
import { PagePlaceholder } from './PagePlaceholder';

interface DeploymentRow {
  id: number;
  project: string;
  commit: string;
  type: 'build' | 'deploy' | 'rollback';
  status: 'running' | 'building' | 'failed';
  deployedAt: string;
}

const COLUMNS: readonly Column<DeploymentRow>[] = [
  {
    key: 'project',
    header: 'Project',
    render: (row) => (
      <span className="cell-primary">
        <span className="cell-primary__name">{row.project}</span>
        <span className="cell-primary__meta">{row.commit}</span>
      </span>
    ),
  },
  { key: 'type', header: 'Type', render: (row) => row.type, hideOnMobile: true, muted: true },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <StatusPill label={row.status} tone={toneForStatus(row.status)} />,
  },
  { key: 'when', header: 'Deployed', align: 'right', render: (row) => row.deployedAt, muted: true },
];

export function Deployments(): JSX.Element {
  const rows: DeploymentRow[] = []; // Phase 4 fills this from /api/deployments

  return (
    <PagePlaceholder
      phase={4}
      title="Deployments"
      description="Every build with its commit, status and the rollback target."
      toolbar={
        <div className="page-toolbar">
          <label className="page-toolbar__search">
            <Icon name="search" size={15} />
            <input type="search" placeholder="Search deployments…" aria-label="Search deployments" disabled />
          </label>
          <select className="page-toolbar__select" aria-label="Filter by project" disabled>
            <option>All projects</option>
          </select>
          <select className="page-toolbar__select" aria-label="Filter by status" disabled>
            <option>All statuses</option>
            <option>Building</option>
            <option>Running</option>
            <option>Failed</option>
          </select>
        </div>
      }
    >
      <Card flush>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          getRowKey={(row) => row.id}
          caption="Deployment history"
          empty={
            <EmptyState
              icon="deployments"
              title="No deployments yet"
              description="Each push to a connected repository will create a deployment with live build logs and a rollback target."
            />
          }
        />
      </Card>
    </PagePlaceholder>
  );
}
