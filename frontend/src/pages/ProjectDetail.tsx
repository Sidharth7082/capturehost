import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { fetchProjectDomains, type ProjectDomain } from '../api/domains';
import {
  ACTIVE_STATUSES,
  cancelDeployment,
  deleteEnv,
  deleteProject,
  deployProject,
  fetchDeployments,
  fetchEnv,
  fetchProject,
  fetchWebhook,
  putEnv,
  rollbackProject,
  updateProject,
  type Deployment,
  type EnvKey,
  type Project,
  type WebhookInfo,
} from '../api/projects';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Skeleton } from '../components/Skeleton';
import { StatusPill, toneForStatus } from '../components/StatusPill';
import { Tabs, type TabItem } from '../components/Tabs';
import { useToast } from '../components/Toast';
import { formatBytes, relativeFromNow } from '../utils/format';
import { DeploymentLog } from './projects/DeploymentLog';
import '../styles/projects.css';

/** Project detail: overview, deployments, live log, environment and settings. */

type TabValue = 'overview' | 'deployments' | 'logs' | 'environment' | 'settings';

const TABS: readonly TabItem<TabValue>[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'deployments', label: 'Deployments' },
  { value: 'logs', label: 'Logs' },
  { value: 'environment', label: 'Environment' },
  { value: 'settings', label: 'Settings' },
];

function durationLabel(deployment: Deployment): string {
  if (!deployment.durationMs) return '—';
  if (deployment.durationMs < 60_000) return `${Math.round(deployment.durationMs / 1000)}s`;
  return `${Math.round(deployment.durationMs / 60_000)}m`;
}

export function ProjectDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [tab, setTab] = useState<TabValue>('overview');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!Number.isFinite(projectId)) return;
    try {
      const [{ project: detail }, { deployments: history }] = await Promise.all([
        fetchProject(projectId),
        fetchDeployments(projectId),
      ]);
      setProject(detail);
      setDeployments(history);
      setError(null);
      if (selectedDeploymentId === null && history[0]) setSelectedDeploymentId(history[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the project');
    }
  }, [projectId, selectedDeploymentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll quickly while a build is running, slowly otherwise.
  const active = deployments.some((deployment) => ACTIVE_STATUSES.includes(deployment.status));
  useEffect(() => {
    const timer = setInterval(() => void load(), active ? 2500 : 15_000);
    return () => clearInterval(timer);
  }, [active, load]);

  const selectedDeployment = useMemo(
    () => deployments.find((deployment) => deployment.id === selectedDeploymentId) ?? deployments[0] ?? null,
    [deployments, selectedDeploymentId],
  );

  const runAction = async (
    label: string,
    action: () => Promise<unknown>,
    options: { focusNewest?: boolean } = {},
  ): Promise<void> => {
    setBusy(true);
    try {
      await action();
      toast.push(label);
      // Deploy and rollback create a new deployment: jump the log viewer to it
      // instead of leaving it on whichever build was open.
      if (options.focusNewest) setSelectedDeploymentId(null);
      await load();
    } catch (err) {
      toast.push(label, { message: err instanceof ApiError ? err.message : 'Unknown error', tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Card>
        <EmptyState
          icon="alert"
          title="Project not found"
          description={error}
          action={
            <Button onClick={() => navigate('/projects')}>
              Back to projects
            </Button>
          }
        />
      </Card>
    );
  }

  if (!project) {
    return (
      <div className="detail-skeleton">
        <Skeleton height="38px" />
        <Skeleton height="120px" />
        <Skeleton height="280px" />
      </div>
    );
  }

  const canRollback = deployments.some(
    (deployment) => deployment.status === 'live' && deployment.id !== project.currentDeploymentId,
  );

  return (
    <>
      <div className="detail-header">
        <Link to="/projects" className="detail-header__back">
          <Icon name="chevron-left" size={15} /> Projects
        </Link>

        <div className="detail-header__row">
          <div>
            <h2 className="detail-header__title">
              {project.name}
              <StatusPill
                label={project.status === 'idle' ? 'Not deployed' : project.status}
                tone={toneForStatus(project.status)}
              />
            </h2>
            <p className="detail-header__meta">
              {project.repoUrl.replace('https://github.com/', '')} · {project.branch} · {project.dockerfilePath}
              {project.url ? (
                <>
                  {' · '}
                  <a className="mono-link" href={project.url} target="_blank" rel="noreferrer">
                    127.0.0.1:{project.hostPort}
                  </a>
                </>
              ) : null}
            </p>
          </div>

          <div className="detail-header__actions">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void runAction('Deploy started', () => deployProject(project.id), { focusNewest: true })
              }
            >
              Deploy
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !canRollback}
              onClick={() =>
                void runAction('Rollback started', () => rollbackProject(project.id), { focusNewest: true })
              }
            >
              Rollback
            </Button>
          </div>
        </div>
      </div>

      <Tabs items={TABS} value={tab} onChange={setTab} label="Project sections" />

      {tab === 'overview' ? (
        <OverviewTab project={project} deployments={deployments} onOpenLog={(deploymentId) => {
          setSelectedDeploymentId(deploymentId);
          setTab('logs');
        }} />
      ) : null}

      {tab === 'deployments' ? (
        <DeploymentsTab
          deployments={deployments}
          busy={busy}
          onViewLog={(deploymentId) => {
            setSelectedDeploymentId(deploymentId);
            setTab('logs');
          }}
          onCancel={(deploymentId) =>
            void runAction('Deployment cancelled', () => cancelDeployment(project.id, deploymentId))
          }
        />
      ) : null}

      {tab === 'logs' ? <DeploymentLog deployment={selectedDeployment} /> : null}

      {tab === 'environment' ? <EnvironmentTab projectId={project.id} /> : null}

      {tab === 'settings' ? <SettingsTab project={project} onChanged={load} /> : null}
    </>
  );
}

function OverviewTab({
  project,
  deployments,
  onOpenLog,
}: {
  project: Project;
  deployments: Deployment[];
  onOpenLog: (deploymentId: number) => void;
}): JSX.Element {
  const latest = deployments[0] ?? null;
  const [domains, setDomains] = useState<(ProjectDomain & { url: string })[]>([]);

  useEffect(() => {
    void fetchProjectDomains(project.id)
      .then(({ domains: list }) => setDomains(list as (ProjectDomain & { url: string })[]))
      .catch(() => setDomains([]));
  }, [project.id]);

  const primary = domains.find((domain) => domain.enabled) ?? domains[0] ?? null;

  return (
    <div className="detail-grid">
      <Card title="Runtime">
        <dl className="kv">
          <dt>Status</dt>
          <dd>{project.status}</dd>
          <dt>Container port</dt>
          <dd className="mono">{project.containerPort}/tcp</dd>
          <dt>Host port</dt>
          <dd className="mono">{project.hostPort ? `127.0.0.1:${project.hostPort}` : 'not assigned yet'}</dd>
          <dt>Network</dt>
          <dd className="mono">capturehost-apps</dd>
          <dt>URL</dt>
          <dd>
            {primary ? (
              <a className="mono-link" href={primary.url} target="_blank" rel="noreferrer">
                {primary.url}
              </a>
            ) : project.url ? (
              <a className="mono-link" href={project.url} target="_blank" rel="noreferrer">
                {project.url}
              </a>
            ) : (
              'not deployed yet'
            )}
          </dd>
        </dl>
      </Card>

      <Card title="Limits">
        <dl className="kv">
          <dt>Memory</dt>
          <dd>{formatBytes(project.limits.memoryLimitMb * 1024 * 1024)} (max {formatBytes(project.limits.maxMemoryMb * 1024 * 1024)})</dd>
          <dt>CPU</dt>
          <dd>{project.limits.cpuLimit} cores (max {project.limits.maxCpu})</dd>
          <dt>Processes</dt>
          <dd>{project.limits.pidsLimit}</dd>
          <dt>Capabilities</dt>
          <dd className="mono">{project.capabilities.join(', ') || 'none'}</dd>
        </dl>
      </Card>

      <Card title="Latest deployment">
        {latest ? (
          <div className="latest">
            <StatusPill label={latest.status} tone={toneForStatus(latest.status)} />
            <p className="latest__meta">
              #{latest.id} · {latest.trigger} · {latest.shortCommit ?? 'no commit'} · {relativeFromNow(latest.createdAt)}
            </p>
            {latest.error ? <p className="latest__error">{latest.error}</p> : null}
            <Button variant="ghost" onClick={() => onOpenLog(latest.id)}>
              View build log
            </Button>
          </div>
        ) : (
          <EmptyState
            icon="deployments"
            title="Nothing deployed yet"
            description="Press Deploy to clone the repository, build its Dockerfile and start the container."
          />
        )}
      </Card>
    </div>
  );
}

function DeploymentsTab({
  deployments,
  busy,
  onViewLog,
  onCancel,
}: {
  deployments: Deployment[];
  busy: boolean;
  onViewLog: (deploymentId: number) => void;
  onCancel: (deploymentId: number) => void;
}): JSX.Element {
  const columns: readonly Column<Deployment>[] = [
    {
      key: 'id',
      header: 'Deploy',
      render: (deployment) => (
        <span className="cell-primary">
          <span className="cell-primary__name">#{deployment.id}</span>
          <span className="cell-primary__meta">{deployment.shortCommit ?? 'no commit'}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (deployment) => (
        <div className="cell-primary">
          <StatusPill label={deployment.status} tone={toneForStatus(deployment.status)} />
          {deployment.diagnosis ? (
            <span className="deploy-diagnosis" title={(deployment.diagnosis.hints ?? []).join(' · ')}>
              {deployment.diagnosis.summary}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'trigger',
      header: 'Trigger',
      hideOnMobile: true,
      muted: true,
      render: (deployment) => (deployment.rollbackOf ? `rollback of #${deployment.rollbackOf}` : deployment.trigger),
    },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      hideOnMobile: true,
      muted: true,
      render: (deployment) => durationLabel(deployment),
    },
    {
      key: 'when',
      header: 'When',
      align: 'right',
      muted: true,
      render: (deployment) => relativeFromNow(deployment.createdAt),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (deployment) => (
        <div className="row-actions">
          <Button variant="ghost" onClick={() => onViewLog(deployment.id)}>
            Log
          </Button>
          {ACTIVE_STATUSES.includes(deployment.status) ? (
            <Button variant="ghost" disabled={busy} onClick={() => onCancel(deployment.id)}>
              Cancel
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <Card flush>
      <DataTable
        columns={columns}
        rows={deployments}
        getRowKey={(deployment) => deployment.id}
        caption="Deployment history"
        empty={
          <EmptyState
            icon="deployments"
            title="No deployments yet"
            description="Every deploy keeps its commit, log and status here, so you can see what changed and go back."
          />
        }
      />
    </Card>
  );
}

function EnvironmentTab({ projectId }: { projectId: number }): JSX.Element {
  const toast = useToast();
  const [keys, setKeys] = useState<EnvKey[] | null>(null);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const { env } = await fetchEnv(projectId);
      setKeys(env);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load environment variables');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await putEnv(projectId, key.trim(), value);
      setKey('');
      setValue('');
      toast.push('Variable saved', { message: 'It is injected the next time the container starts.', tone: 'success' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the variable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail-grid detail-grid--single">
      <Card title="Environment variables" subtitle="Values are encrypted at rest and never shown again.">
        <div className="env-form">
          <input
            className="input"
            placeholder="KEY_NAME"
            aria-label="Variable name"
            value={key}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
          />
          <input
            className="input"
            type="password"
            placeholder="value"
            aria-label="Variable value"
            value={value}
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
          />
          <Button
            variant="primary"
            disabled={busy || key.trim() === '' || !/^[A-Z_][A-Z0-9_]*$/.test(key.trim())}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>

        {error ? <div className="form-error">{error}</div> : null}

        {keys === null ? (
          <Skeleton height="90px" />
        ) : keys.length === 0 ? (
          <EmptyState
            icon="databases"
            title="No variables yet"
            description="Add the keys your container needs. Re-deploy to apply them."
          />
        ) : (
          <ul className="env-list">
            {keys.map((entry) => (
              <li key={entry.key} className="env-list__row">
                <span className="env-list__key">{entry.key}</span>
                <span className="env-list__masked">••••••••••</span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void deleteEnv(projectId, entry.key)
                      .then(() => {
                        toast.push('Variable removed');
                        void load();
                      })
                      .catch(() => toast.push('Could not remove the variable', { tone: 'danger' }));
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function SettingsTab({ project, onChanged }: { project: Project; onChanged: () => Promise<void> }): JSX.Element {
  const toast = useToast();
  const navigate = useNavigate();
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null);
  const [memory, setMemory] = useState(String(project.limits.memoryLimitMb));
  const [cpu, setCpu] = useState(String(project.limits.cpuLimit));
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    void fetchWebhook(project.id)
      .then(setWebhook)
      .catch(() => setWebhook(null));
  }, [project.id]);

  const webhookUrl = `${window.location.origin}${webhook?.path ?? `/api/webhooks/github/${project.id}`}`;

  return (
    <div className="detail-grid">
      <Card title="Webhook" subtitle="Auto-redeploy when you push to this branch.">
        <div className="webhook">
          <label className="field">
            <span className="field__label">Payload URL</span>
            <div className="copy-row">
              <input className="input mono" readOnly value={webhookUrl} />
              <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(webhookUrl)}>
                Copy
              </Button>
            </div>
          </label>

          <label className="field">
            <span className="field__label">Secret</span>
            <div className="copy-row">
              <input className="input mono" readOnly type="password" value={webhook?.secret ?? ''} />
              <Button
                variant="ghost"
                onClick={() => void navigator.clipboard?.writeText(webhook?.secret ?? '')}
                disabled={!webhook?.secret}
              >
                Copy
              </Button>
            </div>
          </label>

          <p className="field__hint">
            In GitHub: Settings → Webhooks → Add webhook. Content type <code>application/json</code>, event
            “push only”. The backend listens on 127.0.0.1, so expose this one path through a tunnel first.
          </p>
        </div>
      </Card>

      <Card title="Resource limits" subtitle={`Hard maximum: ${project.limits.maxMemoryMb} MB and ${project.limits.maxCpu} cores.`}>
        <div className="field-row">
          <label className="field">
            <span className="field__label">Memory (MB)</span>
            <input className="input" value={memory} inputMode="numeric" onChange={(event) => setMemory(event.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">CPU cores</span>
            <input className="input" value={cpu} inputMode="decimal" onChange={(event) => setCpu(event.target.value)} />
          </label>
        </div>
        <Button
          variant="primary"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void updateProject(project.id, {
              memoryLimitMb: Number(memory),
              cpuLimit: Number(cpu),
            })
              .then(async () => {
                toast.push('Limits saved', { message: 'They apply the next time the container is created.', tone: 'success' });
                await onChanged();
              })
              .catch((err: unknown) =>
                toast.push('Could not save limits', {
                  message: err instanceof ApiError ? err.message : 'Unknown error',
                  tone: 'danger',
                }),
              )
              .finally(() => setSaving(false));
          }}
        >
          Save limits
        </Button>
      </Card>

      <Card title="Danger zone" className="card--danger">
        <p className="muted">
          Deleting removes the container, the images built for this project and its deployment history.
        </p>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          Delete project
        </Button>
      </Card>

      <Modal
        open={deleteOpen}
        title="Delete project"
        onClose={() => setDeleteOpen(false)}
        footer={
          <div className="confirm-footer">
            <input
              className="input"
              value={typed}
              placeholder={project.name}
              aria-label="Type the project name to confirm"
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={typed !== project.name}
              onClick={() => {
                void deleteProject(project.id, typed)
                  .then(() => {
                    toast.push('Project deleted');
                    navigate('/projects');
                  })
                  .catch((err: unknown) =>
                    toast.push('Could not delete', {
                      message: err instanceof ApiError ? err.message : 'Unknown error',
                      tone: 'danger',
                    }),
                  );
              }}
            >
              Delete project
            </Button>
          </div>
        }
      >
        <p>
          Type <strong>{project.name}</strong> to confirm. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
