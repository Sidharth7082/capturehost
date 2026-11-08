import { useState, type JSX } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { Dropdown } from '../components/Dropdown';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { PagePlaceholder } from './PagePlaceholder';

interface ProjectRow {
  id: number;
  name: string;
  repoUrl: string;
  branch: string;
  services: number;
  status: string;
  updatedAt: string;
}

const COLUMNS: readonly Column<ProjectRow>[] = [
  {
    key: 'name',
    header: 'Project',
    render: (row) => (
      <span className="cell-primary">
        <span className="cell-primary__name">{row.name}</span>
        <span className="cell-primary__meta">{row.repoUrl}</span>
      </span>
    ),
  },
  { key: 'branch', header: 'Branch', render: (row) => row.branch, hideOnMobile: true, muted: true },
  { key: 'services', header: 'Services', align: 'right', render: (row) => row.services, hideOnMobile: true },
  { key: 'updated', header: 'Updated', align: 'right', render: (row) => row.updatedAt, muted: true },
  {
    key: 'actions',
    header: '',
    align: 'right',
    render: () => (
      <Dropdown
        trigger="more"
        triggerLabel="Project actions"
        items={[
          { key: 'deploy', label: 'Deploy now', icon: 'deployments', onSelect: () => undefined },
          { key: 'logs', label: 'View logs', icon: 'logs', onSelect: () => undefined },
          { key: 'delete', label: 'Delete project', icon: 'close', danger: true, dividerBefore: true, onSelect: () => undefined },
        ]}
      />
    ),
  },
];

export function Projects(): JSX.Element {
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const rows: ProjectRow[] = []; // Phase 4 fills this from /api/projects

  return (
    <>
      <PagePlaceholder
        phase={4}
        title="Projects"
        description="Repositories deployed from GitHub, one container per project."
        toolbar={
          <div className="page-toolbar">
            <label className="page-toolbar__search">
              <Icon name="search" size={15} />
              <input type="search" placeholder="Search projects…" aria-label="Search projects" disabled />
            </label>
            <span className="page-toolbar__spacer" />
            <Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={() => setNewProjectOpen(true)}>
              New Project
            </Button>
          </div>
        }
      >
        <Card flush>
          <DataTable
            columns={COLUMNS}
            rows={rows}
            getRowKey={(row) => row.id}
            caption="Deployed projects"
            empty={
              <EmptyState
                icon="projects"
                title="No projects yet"
                description="Connect a GitHub repository and CaptureHost will clone, build and run it in its own container."
                action={
                  <Button variant="primary" onClick={() => setNewProjectOpen(true)}>
                    New Project
                  </Button>
                }
              />
            }
          />
        </Card>
      </PagePlaceholder>

      <Modal
        open={newProjectOpen}
        title="New project"
        onClose={() => setNewProjectOpen(false)}
      >
        <p>
          Creating projects arrives in Phase 4: repo URL, branch, Dockerfile path, CPU and memory limits, and
          encrypted environment variables. Nothing is submitted here yet.
        </p>
      </Modal>
    </>
  );
}
