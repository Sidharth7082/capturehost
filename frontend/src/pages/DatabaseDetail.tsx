import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { fetchProjects, type Project } from '../api/projects';
import {
  createBackup,
  databaseAction,
  deleteBackup,
  deleteDatabase,
  fetchBackups,
  fetchDatabase,
  fetchLogs,
  fetchMetrics,
  fetchRows,
  fetchTables,
  linkDatabase,
  restoreBackup,
  runQuery,
  unlinkDatabase,
  type DatabaseBackup,
  type DatabaseInfo,
  type QueryResult,
  type TableInfo,
} from '../api/databases';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { StatusPill } from '../components/StatusPill';
import { formatBytes, relativeFromNow } from '../utils/format';
import './DatabaseDetail.css';

type Tab = 'overview' | 'data' | 'backups' | 'links' | 'logs' | 'danger';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'data', label: 'Data' },
  { id: 'backups', label: 'Backups' },
  { id: 'links', label: 'Linked projects' },
  { id: 'logs', label: 'Logs' },
  { id: 'danger', label: 'Danger zone' },
];

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  running: 'success',
  stopped: 'neutral',
  failed: 'danger',
  creating: 'warning',
};

export function DatabaseDetail(): JSX.Element {
  const { id } = useParams();
  const databaseId = Number(id);
  const navigate = useNavigate();
  const location = useLocation() as { state?: { password?: string } };

  // The one-time password arrives from the create flow and is then forgotten.
  const [password, setPassword] = useState<string | null>(location.state?.password ?? null);
  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await fetchDatabase(databaseId);
      setDatabase(result.database);
      setState('ready');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the database');
      setState('error');
    }
  }, [databaseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') return <div className="db-detail"><p className="db-muted">Loading…</p></div>;
  if (state === 'error' || !database) {
    return (
      <div className="db-detail">
        <div className="form-error">{error ?? 'Not found'}</div>
        <Link to="/databases">Back to databases</Link>
      </div>
    );
  }

  return (
    <div className="db-detail">
      <div className="db-detail__head">
        <div>
          <Link to="/databases" className="db-detail__back">
            ← Databases
          </Link>
          <h1 className="page-toolbar__title">{database.name}</h1>
          <p className="page-toolbar__subtitle">
            postgres {database.version} · {database.containerName}
          </p>
        </div>
        <div className="db-detail__head-actions">
          <StatusPill label={database.status} tone={TONE[database.status] ?? 'neutral'} />
          {database.status === 'running' ? (
            <Button variant="ghost" disabled={busy} onClick={() => void act(() => databaseAction(database.id, 'stop'))}>
              Stop
            </Button>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={() => void act(() => databaseAction(database.id, 'start'))}>
              Start
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => void act(() => databaseAction(database.id, 'restart'))}>
            Restart
          </Button>
        </div>
      </div>

      <nav className="db-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`db-tabs__tab${tab === entry.id ? ' db-tabs__tab--active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {error ? <div className="form-error">{error}</div> : null}

      {tab === 'overview' ? (
        <Overview
          database={database}
          password={password}
          onDismissPassword={() => setPassword(null)}
        />
      ) : null}
      {tab === 'data' ? <DataTab database={database} /> : null}
      {tab === 'backups' ? (
        <BackupsTab
          database={database}
          onCreated={(name, newPassword) => {
            void load();
            navigate(`/databases/${name}`, { state: { password: newPassword } });
          }}
        />
      ) : null}
      {tab === 'links' ? <LinksTab database={database} onChange={() => void load()} /> : null}
      {tab === 'logs' ? <LogsTab database={database} /> : null}
      {tab === 'danger' ? (
        <DangerTab
          database={database}
          onDeleted={() => navigate('/databases')}
        />
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------- overview

function Overview({
  database,
  password,
  onDismissPassword,
}: {
  database: DatabaseInfo;
  password: string | null;
  onDismissPassword: () => void;
}): JSX.Element {
  const [metrics, setMetrics] = useState<{ sizeBytes: number; connections: number; version: string | null } | null>(null);

  useEffect(() => {
    if (database.status !== 'running') return;
    void fetchMetrics(database.id).then(setMetrics).catch(() => setMetrics(null));
  }, [database.id, database.status]);

  const copy = (value: string): void => {
    void navigator.clipboard?.writeText(value);
  };

  return (
    <div className="db-grid">
      <Card title="Status" subtitle="What this container is doing right now">
        <div className="security-row">
          <span className="security-row__label">State</span>
          <span className="security-row__value">
            <StatusPill label={database.status} tone={TONE[database.status] ?? 'neutral'} />
          </span>
        </div>
        <div className="security-row">
          <span className="security-row__label">Size on disk</span>
          <span className="security-row__value">
            {metrics ? formatBytes(metrics.sizeBytes) : database.status === 'running' ? '…' : '—'}
          </span>
        </div>
        <div className="security-row">
          <span className="security-row__label">Connections</span>
          <span className="security-row__value">{metrics ? metrics.connections : '—'}</span>
        </div>
        <div className="security-row">
          <span className="security-row__label">Server version</span>
          <span className="security-row__value">{metrics?.version ?? '—'}</span>
        </div>
        <div className="security-row">
          <span className="security-row__label">Volume</span>
          <span className="security-row__value db-mono">{database.volume}</span>
        </div>
        <div className="security-row">
          <span className="security-row__label">Last backup</span>
          <span className="security-row__value">
            {database.lastBackupAt ? relativeFromNow(database.lastBackupAt) : 'never'}
          </span>
        </div>
      </Card>

      <Card title="Connection" subtitle="Everything an app needs, from inside the app network">
        <div className="db-conn">
          <span className="db-conn__label">Host (internal)</span>
          <code className="db-conn__value">{database.internalHost}</code>
          <Button variant="ghost" onClick={() => copy(database.internalHost)}>
            Copy
          </Button>
        </div>
        <div className="db-conn">
          <span className="db-conn__label">Port</span>
          <code className="db-conn__value">{database.internalPort}</code>
          <Button variant="ghost" onClick={() => copy(String(database.internalPort))}>
            Copy
          </Button>
        </div>
        <div className="db-conn">
          <span className="db-conn__label">Database / user</span>
          <code className="db-conn__value">
            {database.dbName} / {database.username}
          </code>
        </div>
        <div className="db-conn">
          <span className="db-conn__label">URL (no password)</span>
          <code className="db-conn__value">{database.internalUrl}</code>
          <Button variant="ghost" onClick={() => copy(database.internalUrl)}>
            Copy
          </Button>
        </div>

        {database.published ? (
          <p className="db-note">
            Published on <code>127.0.0.1:{database.port}</code> for local tools — loopback only, never
            0.0.0.0.
          </p>
        ) : (
          <p className="db-note">
            Internal only. Turn on “Publish on 127.0.0.1” when you create a database if psql on this laptop
            needs to reach it.
          </p>
        )}

        {password ? (
          <div className="db-password">
            <div className="db-password__head">Password — shown once</div>
            <code className="db-password__value">{password}</code>
            <div className="db-password__actions">
              <Button variant="ghost" onClick={() => copy(password)}>
                Copy password
              </Button>
              <Button variant="ghost" onClick={onDismissPassword}>
                I have saved it
              </Button>
            </div>
            <p className="db-password__hint">
              It is stored encrypted and will not be shown again. Paste the full URL into your app’s env
              vars to use it.
            </p>
          </div>
        ) : (
          <p className="db-note db-note--muted">
            The password is only shown when the database is created. If you lost it, link the database to a
            project — that writes a working DATABASE_URL into the project’s env vars.
          </p>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------- data

function DataTab({ database }: { database: DatabaseInfo }): JSX.Element {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<TableInfo | null>(null);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<QueryResult | null>(null);
  const [sql, setSql] = useState('select now() as server_time;');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchTables(database.id)
      .then((response) => setTables(response.tables))
      .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Could not read the schema'));
  }, [database.id]);

  useEffect(() => {
    if (!selected) return;
    void fetchRows(database.id, selected.schema, selected.name, page)
      .then(setRows)
      .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Could not read rows'));
  }, [database.id, selected, page]);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setResult(await runQuery(database.id, sql));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The statement failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="db-data">
      <Card title="Tables" subtitle="Click one to browse its rows">
        {tables.length === 0 ? (
          <p className="db-muted">No tables yet — run a CREATE TABLE below.</p>
        ) : (
          <ul className="db-tables">
            {tables.map((table) => (
              <li key={`${table.schema}.${table.name}`}>
                <button
                  type="button"
                  className={`db-tables__item${selected?.name === table.name ? ' db-tables__item--active' : ''}`}
                  onClick={() => {
                    setSelected(table);
                    setPage(1);
                  }}
                >
                  <span className="db-tables__name">{table.name}</span>
                  <span className="db-tables__schema">{table.schema}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={selected ? `${selected.schema}.${selected.name}` : 'Rows'} subtitle="Read-only browse, 200 rows a page">
        {selected ? (
          <>
            <ResultTable result={rows} />
            <div className="db-pager">
              <Button variant="ghost" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>
                Previous
              </Button>
              <span className="db-muted">page {page}</span>
              <Button
                variant="ghost"
                disabled={!rows?.truncated}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          </>
        ) : (
          <p className="db-muted">Pick a table on the left.</p>
        )}
      </Card>

      <Card title="SQL" subtitle="Runs as the database owner, with a 10 s statement timeout">
        <textarea
          className="input db-sql"
          value={sql}
          spellCheck={false}
          onChange={(event) => setSql(event.target.value)}
        />
        <div className="db-sql__actions">
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? 'Running…' : 'Run'}
          </Button>
          <span className="db-muted">Every statement is audited; results are never logged.</span>
        </div>
        {error ? <div className="form-error">{error}</div> : null}
        {result ? <ResultTable result={result} /> : null}
      </Card>
    </div>
  );
}

function ResultTable({ result }: { result: QueryResult | null }): JSX.Element {
  if (!result) return <p className="db-muted">No result yet.</p>;
  if (result.rows.length === 0) {
    return (
      <p className="db-muted">
        {result.rowCount} row(s) affected in {result.durationMs} ms.
      </p>
    );
  }

  return (
    <div className="db-result">
      <table>
        <thead>
          <tr>
            {result.columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index}>
              {result.columns.map((column) => (
                <td key={column}>{formatCell(row[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="db-muted">
        {result.rowCount} row(s) in {result.durationMs} ms{result.truncated ? ' — truncated' : ''}
      </p>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ------------------------------------------------------------------- backups

function BackupsTab({
  database,
  onCreated,
}: {
  database: DatabaseInfo;
  onCreated: (id: number, password: string) => void;
}): JSX.Element {
  const [backups, setBackups] = useState<DatabaseBackup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreName, setRestoreName] = useState('');

  const load = useCallback(async () => {
    try {
      setBackups((await fetchBackups(database.id)).backups);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load backups');
    }
  }, [database.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work');
    } finally {
      setBusy(false);
      await load();
    }
  };

  return (
    <div className="db-grid">
      <Card title="Snapshots" subtitle="pg_dump via a short-lived helper container, encrypted at rest">
        <div className="db-backup__actions">
          <Button
            variant="primary"
            disabled={busy || database.status !== 'running'}
            onClick={() => void act(() => createBackup(database.id))}
          >
            {busy ? 'Working…' : 'Back up now'}
          </Button>
          <span className="db-muted">
            {database.status === 'running' ? 'Runs immediately.' : 'Start the database first.'}
          </span>
        </div>

        {error ? <div className="form-error">{error}</div> : null}

        {backups.length === 0 ? (
          <p className="db-muted">No snapshots yet.</p>
        ) : (
          <ul className="db-backups">
            {backups.map((backup) => (
              <li key={backup.fileName} className="db-backups__row">
                <span className="db-backups__when">{relativeFromNow(backup.createdAt)}</span>
                <span className="db-backups__size">{formatBytes(backup.sizeBytes)}</span>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act(() => deleteBackup(database.id, backup.fileName))}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Restore" subtitle="Always into a NEW database — the source is never overwritten">
        <label className="field">
          <span className="field__label">New database name</span>
          <input
            className="input"
            value={restoreName}
            placeholder="shop-restored"
            onChange={(event) => setRestoreName(event.target.value.toLowerCase())}
          />
          <span className="field__hint">The newest snapshot is restored into a fresh container.</span>
        </label>
        <Button
          variant="primary"
          disabled={busy || backups.length === 0 || !/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(restoreName)}
          onClick={() => {
            const newest = backups[0];
            if (!newest) return;
            void act(async () => {
              const restored = await restoreBackup(database.id, newest.fileName, restoreName);
              onCreated(restored.database.id, restored.password);
            });
          }}
        >
          Restore into a new database
        </Button>
      </Card>
    </div>
  );
}

// --------------------------------------------------------------------- links

function LinksTab({ database, onChange }: { database: DatabaseInfo; onChange: () => void }): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchProjects()
      .then((response) => setProjects(response.projects))
      .catch(() => setProjects([]));
  }, []);

  const linkedIds = useMemo(() => new Set(database.links.map((link) => link.projectId)), [database.links]);
  const available = projects.filter((project) => !linkedIds.has(project.id));

  return (
    <div className="db-grid">
      <Card title="Linked projects" subtitle="Linking writes DATABASE_URL into the project’s encrypted env vars">
        {database.links.length === 0 ? (
          <p className="db-muted">Not linked to any project yet.</p>
        ) : (
          <ul className="db-links">
            {database.links.map((link) => (
              <li key={link.projectId} className="db-links__row">
                <Link to={`/projects/${link.projectId}`}>{link.projectName}</Link>
                <code>{link.envKey}</code>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void unlinkDatabase(database.id, link.projectId).then(() => {
                      setNotice('Unlinked. The env var was removed.');
                      onChange();
                    });
                  }}
                >
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        )}

        {notice ? <div className="form-notice">{notice}</div> : null}
        {error ? <div className="form-error">{error}</div> : null}
      </Card>

      <Card title="Link a project" subtitle="The project has to be redeployed afterwards">
        <label className="field">
          <span className="field__label">Project</span>
          <select className="input" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Choose a project…</option>
            {available.map((project) => (
              <option key={project.id} value={String(project.id)}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="primary"
          disabled={projectId === ''}
          onClick={() => {
            void linkDatabase(database.id, Number(projectId))
              .then(() => {
                setNotice('Linked. Redeploy the project so it picks up DATABASE_URL.');
                setProjectId('');
                onChange();
              })
              .catch((caught: unknown) =>
                setError(caught instanceof ApiError ? caught.message : 'Could not link'),
              );
          }}
        >
          Link DATABASE_URL
        </Button>
        <p className="db-note">
          A running container keeps its old environment. Deploy the project again to apply the change.
        </p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------- logs

function LogsTab({ database }: { database: DatabaseInfo }): JSX.Element {
  const [logs, setLogs] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchLogs(database.id, 200)
      .then((response) => setLogs(response.logs))
      .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Could not read logs'));
  }, [database.id]);

  return (
    <Card title="Container logs" subtitle="Postgres startup and connection messages">
      {error ? <div className="form-error">{error}</div> : null}
      <pre className="db-logs">{logs || 'No output yet.'}</pre>
    </Card>
  );
}

// -------------------------------------------------------------------- danger

function DangerTab({ database, onDeleted }: { database: DatabaseInfo; onDeleted: () => void }): JSX.Element {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  return (
    <Card title="Delete this database" subtitle="The container and its row are removed; the volume is not">
      <p className="db-note">
        Deleting is refused while the database is running or linked to a project. The data volume
        <code> {database.volume} </code>
        is left behind on purpose — this process cannot delete volumes — so you can remove it yourself with
        <code> docker volume rm {database.volume}</code> once you are sure.
      </p>

      <label className="field">
        <span className="field__label">Type the database name to confirm</span>
        <input className="input" value={confirm} placeholder={database.name} onChange={(event) => setConfirm(event.target.value)} />
      </label>

      {error ? <div className="form-error">{error}</div> : null}
      {result ? <div className="form-notice">{result}</div> : null}

      <Button
        variant="ghost"
        disabled={confirm !== database.name}
        onClick={() => {
          void deleteDatabase(database.id, confirm)
            .then((response) => {
              setResult(`Deleted. Run: ${response.removeCommand}`);
              onDeleted();
            })
            .catch((caught: unknown) =>
              setError(caught instanceof ApiError ? caught.message : 'Could not delete'),
            );
        }}
      >
        Delete database
      </Button>
    </Card>
  );
}
