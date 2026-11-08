import { type JSX } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { Dropdown } from '../components/Dropdown';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { StatusPill, toneForStatus } from '../components/StatusPill';
import { PagePlaceholder } from './PagePlaceholder';

interface ContainerRow {
  id: string;
  name: string;
  image: string;
  status: 'running' | 'stopped' | 'failed';
  ports: string;
  cpu: string;
  memory: string;
}

const COLUMNS: readonly Column<ContainerRow>[] = [
  {
    key: 'name',
    header: 'Container',
    render: (row) => (
      <span className="cell-primary">
        <span className="cell-primary__name">{row.name}</span>
        <span className="cell-primary__meta">{row.image}</span>
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <StatusPill label={row.status} tone={toneForStatus(row.status)} />,
  },
  { key: 'ports', header: 'Ports', render: (row) => row.ports, hideOnMobile: true, muted: true },
  { key: 'cpu', header: 'CPU', align: 'right', render: (row) => row.cpu, hideOnMobile: true },
  { key: 'mem', header: 'Memory', align: 'right', render: (row) => row.memory, hideOnMobile: true },
  {
    key: 'actions',
    header: '',
    align: 'right',
    render: () => (
      <Dropdown
        trigger="more"
        triggerLabel="Container actions"
        items={[
          { key: 'start', label: 'Start', icon: 'check', onSelect: () => undefined },
          { key: 'restart', label: 'Restart', icon: 'refresh', onSelect: () => undefined },
          { key: 'logs', label: 'Tail logs', icon: 'logs', onSelect: () => undefined },
          { key: 'stop', label: 'Stop', icon: 'close', danger: true, dividerBefore: true, onSelect: () => undefined },
        ]}
      />
    ),
  },
];

export function Containers(): JSX.Element {
  const rows: ContainerRow[] = []; // Phase 3 fills this from the socket proxy

  return (
    <PagePlaceholder
      phase={3}
      title="Containers"
      description="Docker workloads on this host, read through the socket proxy — never the raw Docker socket."
      toolbar={
        <div className="page-toolbar">
          <label className="page-toolbar__search">
            <Icon name="search" size={15} />
            <input type="search" placeholder="Search containers…" aria-label="Search containers" disabled />
          </label>
          <select className="page-toolbar__select" aria-label="Filter by status" disabled>
            <option>All statuses</option>
            <option>Running</option>
            <option>Stopped</option>
            <option>Failed</option>
          </select>
          <span className="page-toolbar__spacer" />
          <Button icon={<Icon name="refresh" size={15} />} disabled>
            Refresh
          </Button>
        </div>
      }
    >
      <Card flush>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          getRowKey={(row) => row.id}
          caption="Docker containers"
          empty={
            <EmptyState
              icon="containers"
              title="No containers yet"
              description="Deploy a project and its container will appear here with live CPU and memory usage."
            />
          }
        />
      </Card>
    </PagePlaceholder>
  );
}
