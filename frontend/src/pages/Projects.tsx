import { useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { deleteProject, deployProject, fetchProjects, type Project } from '../api/projects';
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
import { relativeFromNow } from '../utils/format';
import { NewProjectModal } from './projects/NewProjectModal';
import '../styles/projects.css';

/** Projects: one GitHub repository, one container, one row. */

const STATUS_LABELS: Record<string, string> = {
  idle: 'Not deployed',
  deploying: 'Deploying',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
};

export function Projects(): JSX.Element {
  const toast = useToast();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = async (): Promise<void> => {
    try {
      const { projects: list } = await fetchProjects();
      setProjects(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load projects');
    }
  };

  useEffect(() => {
    void load();
    // A deployment can finish while the list is open; a slow poll keeps the
    // status pills honest without opening a socket per row.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  const filtered = useMemo(() => {
    if (!projects) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (project) => project.name.toLowerCase().includes(needle) || project.repoUrl.toLowerCase().includes(needle),
    );
  }, [projects, query]);

  const onDeploy = async (project: Project): Promise<void> => {
    setBusyId(project.id);
    try {
      await deployProject(project.id);
      toast.push(`Deploying ${project.name}`, { message: 'Watch the build log on the project page.', tone: 'success' });
      void load();
    } catch (err) {
      toast.push('Could not start the deploy', { message: err instanceof ApiError ? err.message : 'Unknown error', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (project: Project, confirm: string): Promise<void> => {
    try {
      await deleteProject(project.id, confirm);
      toast.push(`${project.name} deleted`, { message: 'Its container and images were removed.', tone: 'success' });
      setPendingDelete(null);
      void load();
    } catch (err) {
      toast.push('Could not delete the project', { message: err instanceof ApiError ? err.message : 'Unknown error', tone: 'danger' });
    }
  };

  const columns: readonly Column<Project>[] = [
    {
      key: 'name',
      header: 'Project',
      render: (project) => (
        <span className="cell-primary">
          <Link to={`/projects/${project.id}`} className="cell-primary__name cell-link">
            {project.name}
          </Link>
          <span className="cell-primary__meta">
            {project.repoUrl.replace('https://github.com/', '')} · {project.branch}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (project) => (
        <StatusPill label={STATUS_LABELS[project.status] ?? project.status} tone={toneForStatus(project.status)} />
      ),
    },
    {
      key: 'url',
      header: 'Serving',
      hideOnMobile: true,
      muted: true,
      render: (project) =>
        project.url ? (
          <a className="mono-link" href={project.url} target="_blank" rel="noreferrer">
            127.0.0.1:{project.hostPort}
          </a>
        ) : (
          '—'
        ),
    },
    {
      key: 'lastDeploy',
      header: 'Last deploy',
      align: 'right',
      hideOnMobile: true,
      muted: true,
      render: (project) => (project.lastDeployedAt ? relativeFromNow(project.lastDeployedAt) : 'Never'),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (project) => (
        <Dropdown
          trigger="more"
          triggerLabel={`Actions for ${project.name}`}
          items={[
            { key: 'open', label: 'Open project', icon: 'projects', onSelect: () => navigate(`/projects/${project.id}`) },
            {
              key: 'deploy',
              label: busyId === project.id ? 'Starting…' : 'Deploy now',
              icon: 'deployments',
              disabled: busyId === project.id,
              onSelect: () => void onDeploy(project),
            },
            {
              key: 'delete',
              label: 'Delete project',
              icon: 'close',
              danger: true,
              dividerBefore: true,
              onSelect: () => setPendingDelete(project),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <>
      <div className="page-toolbar">
        <label className="page-toolbar__search">
          <Icon name="search" size={15} />
          <input
            type="search"
            placeholder="Search projects…"
            aria-label="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="page-toolbar__spacer" />
        <Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={() => setNewOpen(true)}>
          New Project
        </Button>
      </div>

      {error ? (
        <Card>
          <EmptyState
            icon="alert"
            title="Could not load projects"
            description={error}
            action={<Button onClick={() => void load()}>Try again</Button>}
          />
        </Card>
      ) : projects === null ? (
        <Card flush>
          <div className="projects-skeleton">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} height="64px" />
            ))}
          </div>
        </Card>
      ) : (
        <Card flush>
          <DataTable
            columns={columns}
            rows={filtered}
            getRowKey={(project) => project.id}
            caption="Deployed projects"
            empty={
              <EmptyState
                icon="projects"
                title={query ? 'No project matches that search' : 'No projects yet'}
                description={
                  query
                    ? 'Try a different name or repository.'
                    : 'Connect a GitHub repository and CaptureHost will clone, build and run it in its own locked-down container.'
                }
                action={
                  query ? undefined : (
                    <Button variant="primary" onClick={() => setNewOpen(true)}>
                      New Project
                    </Button>
                  )
                }
              />
            }
          />
        </Card>
      )}

      <NewProjectModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(project) => {
          setNewOpen(false);
          toast.push(`${project.name} created`, { message: 'Open it and press Deploy to build the image.', tone: 'success' });
          void load();
        }}
      />

      <Modal
        open={pendingDelete !== null}
        title="Delete project"
        onClose={() => setPendingDelete(null)}
        footer={
          pendingDelete ? (
            <DeleteFooter project={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={onDelete} />
          ) : null
        }
      >
        {pendingDelete ? (
          <div className="confirm-body">
            <p>
              This removes <strong>{pendingDelete.name}</strong>, its container, its images and its deployment
              history. Domains attached to it go too.
            </p>
            <p className="muted">Type the project name to confirm.</p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

/** Confirm stays disabled until the typed name matches the project. */
function DeleteFooter({
  project,
  onCancel,
  onConfirm,
}: {
  project: Project;
  onCancel: () => void;
  onConfirm: (project: Project, confirm: string) => Promise<void>;
}): JSX.Element {
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);

  return (
    <div className="confirm-footer">
      <input
        className="input"
        value={typed}
        placeholder={project.name}
        aria-label="Type the project name to confirm"
        onChange={(event) => setTyped(event.target.value)}
      />
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        variant="danger"
        disabled={typed !== project.name || working}
        onClick={() => {
          setWorking(true);
          void onConfirm(project, typed).finally(() => setWorking(false));
        }}
      >
        {working ? 'Deleting…' : 'Delete project'}
      </Button>
    </div>
  );
}
