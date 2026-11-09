import { useCallback, useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  DUMP_ACCEPT,
  POSTGRES_VERSIONS,
  cloneDatabase,
  createDatabase,
  fetchDatabases,
  importNewDatabase,
  type DatabaseInfo,
} from '../api/databases';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { StatusPill } from '../components/StatusPill';
import { relativeFromNow } from '../utils/format';
import './Databases.css';

/**
 * Databases list.
 *
 * Postgres only, one container each, data on a named volume owned by CaptureHost.
 * Creating one is the only thing that happens here; everything else is on the
 * detail page, because that is where the password is shown once and where the
 * backup and query tools live.
 */

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  running: 'success',
  stopped: 'neutral',
  failed: 'danger',
  creating: 'warning',
};

export function Databases(): JSX.Element {
  const navigate = useNavigate();
  const [rows, setRows] = useState<DatabaseInfo[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await fetchDatabases();
      setRows(result.databases);
      setState('ready');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load databases');
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Column<DatabaseInfo>[] = [
    {
      key: 'name',
      header: 'Database',
      render: (row) => (
        <div className="cell-primary">
          <span className="cell-primary__name">{row.name}</span>
          <span className="cell-primary__meta">
            postgres {row.version} · {row.dbName}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusPill label={row.status} tone={TONE[row.status] ?? 'neutral'} />,
    },
    {
      key: 'access',
      header: 'Access',
      hideOnMobile: true,
      render: (row) =>
        row.published ? (
          <span className="db-mono">127.0.0.1:{row.port}</span>
        ) : (
          <span className="db-muted">internal only</span>
        ),
    },
    {
      key: 'links',
      header: 'Linked',
      hideOnMobile: true,
      render: (row) => (row.links.length === 0 ? <span className="db-muted">—</span> : row.links.length),
    },
    {
      key: 'backup',
      header: 'Last backup',
      hideOnMobile: true,
      muted: true,
      render: (row) =>
        row.lastBackupAt ? relativeFromNow(row.lastBackupAt) : <span className="db-muted">never</span>,
    },
  ];

  return (
    <div className="db-page">
      <div className="page-toolbar">
        <div>
          <h1 className="page-toolbar__title">Databases</h1>
          <p className="page-toolbar__subtitle">Postgres containers with their data on named volumes</p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          New database
        </Button>
      </div>

      {state === 'error' ? <div className="form-error">{error}</div> : null}

      <Card flush>
        {state === 'loading' ? (
          <p className="db-muted" style={{ padding: 16 }}>
            Loading…
          </p>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            onRowClick={(row) => navigate(`/databases/${row.id}`)}
            caption="Managed databases"
            empty={
              <EmptyState
                icon="databases"
                title="No databases yet"
                description="Create a Postgres database, then link it to a project to get a DATABASE_URL."
                action={
                  <Button variant="primary" onClick={() => setOpen(true)}>
                    New database
                  </Button>
                }
              />
            }
          />
        )}
      </Card>

      <NewDatabaseModal
        open={open}
        sources={rows}
        onClose={() => setOpen(false)}
        onCreated={(database, password) => {
          setOpen(false);
          void load();
          // The password travels in router state so the detail page can show it
          // once; it is never fetched again.
          navigate(`/databases/${database.id}`, { state: { password } });
        }}
      />
    </div>
  );
}

function NewDatabaseModal({
  open,
  sources,
  onClose,
  onCreated,
}: {
  open: boolean;
  sources: DatabaseInfo[];
  onClose: () => void;
  onCreated: (database: DatabaseInfo, password: string) => void;
}): JSX.Element {
  const [mode, setMode] = useState<'empty' | 'clone' | 'upload'>('empty');
  const [name, setName] = useState('');
  const [version, setVersion] = useState<string>(POSTGRES_VERSIONS[0]);
  const [published, setPublished] = useState(false);
  const [sourceId, setSourceId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const validName = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(name);
  const cloneSource = sources.find((entry) => String(entry.id) === sourceId) ?? null;
  const canSubmit =
    validName && !working && (mode === 'clone' ? cloneSource !== null : mode === 'upload' ? file !== null : true);

  const submit = async (): Promise<void> => {
    setWorking(true);
    setError(null);
    try {
      if (mode === 'clone' && cloneSource) {
        const result = await cloneDatabase(cloneSource.id, name);
        setName('');
        onCreated(result.database, result.password);
        return;
      }

      if (mode === 'upload' && file) {
        const result = await importNewDatabase(file, { name, version });
        setName('');
        setFile(null);
        onCreated(result.database, result.password);
        return;
      }

      const result = await createDatabase({ name, version, published });
      setName('');
      onCreated(result.database, result.password);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the database');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal
      open={open}
      title="New database"
      onClose={onClose}
      footer={
        <div className="modal-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {working ? 'Working…' : mode === 'upload' ? 'Upload and import' : mode === 'clone' ? 'Clone database' : 'Create database'}
          </Button>
        </div>
      }
    >
      <div className="form">
        <div className="repo-tabs" role="tablist" aria-label="How to start the database">
          {(
            [
              ['empty', 'Empty'],
              ['clone', 'Clone existing'],
              ['upload', 'Upload a dump'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={`repo-tabs__tab${mode === value ? ' repo-tabs__tab--active' : ''}`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="input"
            value={name}
            placeholder="shop-db"
            autoFocus
            onChange={(event) => setName(event.target.value.toLowerCase())}
          />
          <span className="field__hint">
            Becomes the container name, the volume and the database name (dashes become underscores).
          </span>
        </label>

        {mode === 'clone' ? (
          <label className="field">
            <span className="field__label">Copy data from</span>
            <select className="input" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              <option value="">Choose a database…</option>
              {sources.map((entry) => (
                <option key={entry.id} value={String(entry.id)} disabled={entry.status !== 'running'}>
                  {entry.name} {entry.status !== 'running' ? '(stopped)' : ''}
                </option>
              ))}
            </select>
            <span className="field__hint">
              The source must be running. It is only read — the copy lands in a brand new database.
            </span>
          </label>
        ) : null}

        {mode === 'upload' ? (
          <>
            <label className="field">
              <span className="field__label">Dump file</span>
              <input
                className="input"
                type="file"
                accept={DUMP_ACCEPT}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <span className="field__hint">
                A <code>pg_dump</code> archive (<code>-Fc</code> or <code>-Ft</code>), or a plain{' '}
                <code>.sql</code> file. Gzipped is fine. The format is detected from the contents, not the
                name.
              </span>
            </label>

            <label className="field">
              <span className="field__label">Postgres version</span>
              <select className="input" value={version} onChange={(event) => setVersion(event.target.value)}>
                {POSTGRES_VERSIONS.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
              <span className="field__hint">
                Pick a version at least as new as the one the dump came from.
              </span>
            </label>
          </>
        ) : (
          <label className="db-checkbox">
            <input type="checkbox" checked={published} onChange={(event) => setPublished(event.target.checked)} />
            <span>
              <span className="db-checkbox__label">Publish on 127.0.0.1 for local tools</span>
              <span className="field__hint">
                Loopback only, never 0.0.0.0. Apps reach the database by container name without this.
              </span>
            </span>
          </label>
        )}

        {error ? <div className="form-error">{error}</div> : null}
      </div>
    </Modal>
  );
}
