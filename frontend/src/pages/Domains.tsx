import { useEffect, useMemo, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import {
  checkDomain,
  createDomain,
  deleteDomain,
  fetchCaddyStatus,
  fetchDomains,
  setDomainEnabled,
  type CaddyStatus,
  type Domain,
} from '../api/domains';
import { fetchProjects, type Project } from '../api/projects';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { Dropdown } from '../components/Dropdown';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Skeleton } from '../components/Skeleton';
import { StatusPill, type StatusTone } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { relativeFromNow } from '../utils/format';
import '../styles/domains.css';

/** Domains: hostnames attached to projects, applied through Caddy. */

const MODE_COPY: Record<CaddyStatus['mode'], string> = {
  local: 'Hostnames under *.localhost resolve to this machine with no DNS setup.',
  tunnel: 'A Cloudflare Tunnel in front terminates HTTPS; Caddy listens on loopback.',
  public: 'Direct 80/443 with automatic HTTPS. Untested — many home lines cannot accept inbound traffic.',
};

function toneForDomain(domain: Domain): StatusTone {
  if (!domain.enabled) return 'neutral';
  if (domain.status === 'active') return 'success';
  if (domain.status === 'error') return 'danger';
  return 'warning';
}

function labelForDomain(domain: Domain): string {
  if (!domain.enabled) return 'Disabled';
  if (domain.status === 'active') return 'Active';
  if (domain.status === 'error') return 'Error';
  return 'Pending';
}

export function Domains(): JSX.Element {
  const toast = useToast();

  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [caddy, setCaddy] = useState<CaddyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Domain | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = async (): Promise<void> => {
    try {
      const [{ domains: list }, status] = await Promise.all([fetchDomains(), fetchCaddyStatus()]);
      setDomains(list);
      setCaddy(status);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load domains');
    }
  };

  useEffect(() => {
    void load();
    void fetchProjects()
      .then(({ projects: list }) => setProjects(list))
      .catch(() => setProjects([]));

    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const columns: readonly Column<Domain>[] = [
    {
      key: 'hostname',
      header: 'Hostname',
      render: (domain) => (
        <span className="cell-primary">
          <a className="cell-link" href={domain.url} target="_blank" rel="noreferrer">
            {domain.hostname}
          </a>
          <span className="cell-primary__meta">
            {domain.projectName}
            {domain.upstreamPort ? ` · → 127.0.0.1:${domain.upstreamPort}` : ' · not deployed yet'}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (domain) => <StatusPill label={labelForDomain(domain)} tone={toneForDomain(domain)} />,
    },
    {
      key: 'latency',
      header: 'Check',
      hideOnMobile: true,
      muted: true,
      render: (domain) =>
        domain.lastCheckedAt
          ? `${domain.latencyMs !== null ? `${domain.latencyMs} ms` : '—'} · ${relativeFromNow(domain.lastCheckedAt)}`
          : 'never',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (domain) => (
        <Dropdown
          trigger="more"
          triggerLabel={`Actions for ${domain.hostname}`}
          items={[
            {
              key: 'open',
              label: 'Open site',
              icon: 'domains',
              onSelect: () => window.open(domain.url, '_blank', 'noreferrer'),
            },
            {
              key: 'check',
              label: busyId === domain.id ? 'Checking…' : 'Health check',
              icon: 'refresh',
              disabled: busyId === domain.id,
              onSelect: () => {
                setBusyId(domain.id);
                void checkDomain(domain.id)
                  .then((result) => {
                    toast.push(result.ok ? 'Domain answers' : 'Domain did not answer', {
                      message: result.ok ? `HTTP ${result.status} in ${result.latencyMs} ms` : result.error ?? 'no response',
                      tone: result.ok ? 'success' : 'danger',
                    });
                    void load();
                  })
                  .catch((err: unknown) =>
                    toast.push('Check failed', {
                      message: err instanceof ApiError ? err.message : 'Unknown error',
                      tone: 'danger',
                    }),
                  )
                  .finally(() => setBusyId(null));
              },
            },
            {
              key: 'toggle',
              label: domain.enabled ? 'Disable' : 'Enable',
              icon: 'refresh',
              onSelect: () => {
                void setDomainEnabled(domain.id, !domain.enabled)
                  .then(() => {
                    toast.push(domain.enabled ? 'Domain disabled' : 'Domain enabled', { tone: 'success' });
                    void load();
                  })
                  .catch(() => toast.push('Could not update the domain', { tone: 'danger' }));
              },
            },
            {
              key: 'delete',
              label: 'Remove domain',
              icon: 'close',
              danger: true,
              dividerBefore: true,
              onSelect: () => setPendingDelete(domain),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <>
      {caddy ? <CaddyBanner status={caddy} onRetry={() => void load()} /> : null}

      <div className="page-toolbar">
        <span className="page-toolbar__spacer" />
        <Button
          variant="primary"
          icon={<Icon name="plus" size={15} />}
          disabled={projects.length === 0}
          onClick={() => setAddOpen(true)}
        >
          Add domain
        </Button>
      </div>

      {error ? (
        <Card>
          <EmptyState
            icon="alert"
            title="Could not load domains"
            description={error}
            action={<Button onClick={() => void load()}>Try again</Button>}
          />
        </Card>
      ) : domains === null ? (
        <Card flush>
          <div className="domains-skeleton">
            {[0, 1].map((row) => (
              <Skeleton key={row} height="64px" />
            ))}
          </div>
        </Card>
      ) : (
        <Card flush>
          <DataTable
            columns={columns}
            rows={domains}
            getRowKey={(domain) => domain.id}
            caption="Project domains"
            empty={
              <EmptyState
                icon="domains"
                title="No domains attached"
                description={
                  caddy?.mode === 'local'
                    ? 'Attach something like hello.capturehost.localhost — it resolves to this machine with no DNS setup.'
                    : 'Attach a hostname under your allowed base domain and Caddy will route it to the project.'
                }
                action={
                  projects.length > 0 ? (
                    <Button variant="primary" onClick={() => setAddOpen(true)}>
                      Add domain
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </Card>
      )}

      <AddDomainModal
        open={addOpen}
        projects={projects}
        mode={caddy?.mode ?? 'local'}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          void load();
        }}
      />

      <Modal
        open={pendingDelete !== null}
        title="Remove domain"
        onClose={() => setPendingDelete(null)}
        footer={
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!pendingDelete) return;
                const target = pendingDelete;
                void deleteDomain(target.id)
                  .then(() => {
                    toast.push('Domain removed', { message: target.hostname, tone: 'success' });
                    setPendingDelete(null);
                    void load();
                  })
                  .catch(() => toast.push('Could not remove the domain', { tone: 'danger' }));
              }}
            >
              Remove
            </Button>
          </div>
        }
      >
        <p>
          This removes the Caddy route for <strong>{pendingDelete?.hostname}</strong>. The project and its container
          stay up; the site simply stops answering on that hostname.
        </p>
      </Modal>
    </>
  );
}

function CaddyBanner({ status, onRetry }: { status: CaddyStatus; onRetry: () => void }): JSX.Element {
  const tone = !status.reachable ? 'danger' : status.drift ? 'warning' : 'success';

  return (
    <div className={`caddy-banner caddy-banner--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={tone === 'danger' ? 'alert' : tone === 'warning' ? 'info' : 'check'} size={16} />
      <div className="caddy-banner__text">
        <strong>
          {!status.reachable
            ? 'Caddy is not reachable'
            : status.drift
              ? 'Caddy config drifted — repairing'
              : `Caddy ${status.version ?? ''} · ${status.mode} mode`.trim()}
        </strong>
        <span>
          {!status.reachable
            ? (status.error ?? 'Start it with: sudo systemctl start caddy')
            : status.drift
              ? 'SQLite and Caddy disagreed; the routes were re-applied from the database.'
              : MODE_COPY[status.mode]}
        </span>
      </div>
      <span className="caddy-banner__meta">
        {status.managedRoutes} route{status.managedRoutes === 1 ? '' : 's'} · {status.appsListen}
      </span>
      {!status.reachable ? (
        <Button variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function AddDomainModal({
  open,
  projects,
  mode,
  onClose,
  onCreated,
}: {
  open: boolean;
  projects: Project[];
  mode: CaddyStatus['mode'];
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const toast = useToast();
  const [projectId, setProjectId] = useState('');
  const [hostname, setHostname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open && projects[0] && projectId === '') setProjectId(String(projects[0].id));
  }, [open, projects, projectId]);

  const preview = useMemo(() => (/^[a-z0-9.-]+$/.test(hostname) && hostname.includes('.') ? `http://${hostname}:8080` : ''), [hostname]);
  const canSubmit = projectId !== '' && hostname.trim() !== '' && !working;

  return (
    <Modal
      open={open}
      title="Add domain"
      onClose={onClose}
      footer={
        <div className="modal-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() => {
              setWorking(true);
              setError(null);
              void createDomain(Number(projectId), hostname.trim().toLowerCase())
                .then(() => {
                  toast.push('Domain attached', {
                    message: 'The route was written to Caddy; run a health check to confirm.',
                    tone: 'success',
                  });
                  setHostname('');
                  onCreated();
                })
                .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not add the domain'))
                .finally(() => setWorking(false));
            }}
          >
            {working ? 'Adding…' : 'Add domain'}
          </Button>
        </div>
      }
    >
      <div className="form">
        <label className="field">
          <span className="field__label">Project</span>
          <select className="input" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.hostPort ? ` (port ${project.hostPort})` : ' (not deployed)'}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Hostname</span>
          <input
            className="input"
            value={hostname}
            placeholder={mode === 'local' ? 'hello.capturehost.localhost' : 'hello.example.com'}
            autoFocus
            onChange={(event) => setHostname(event.target.value.toLowerCase())}
          />
          <span className="field__hint">
            Lowercase, no scheme, no port. It must end with an allowed base domain and be unique.
          </span>
          {preview ? <span className="field__hint">Will answer at {preview}</span> : null}
        </label>

        <div className="field__hint">
          {mode === 'local'
            ? 'Nothing else to do: *.localhost already resolves to this machine. Open the URL above once the project is deployed.'
            : mode === 'tunnel'
              ? 'Point the tunnel hostname at Caddy, then add it here. HTTPS is terminated by the tunnel.'
              : 'Create the DNS record first. Caddy obtains a certificate on first request; this can take a few seconds.'}
        </div>

        {error ? <div className="form-error">{error}</div> : null}
      </div>
    </Modal>
  );
}
