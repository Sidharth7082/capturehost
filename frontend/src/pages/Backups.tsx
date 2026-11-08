import { useCallback, useEffect, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import {
  createBackup,
  deleteBackup,
  downloadBackup,
  fetchBackups,
  type BackupEntry,
  type BackupList,
} from '../api/ops';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import backupsEmptiness from '../assets/empty/backups.webp';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Skeleton } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { relativeFromNow } from '../utils/format';
import '../styles/ops.css';

/** Backups: encrypted SQLite snapshots, created here or on a schedule. */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Backups(): JSX.Element {
  const toast = useToast();
  const [data, setData] = useState<BackupList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState<BackupEntry | null>(null);
  const [password, setPassword] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await fetchBackups());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load backups');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: readonly Column<BackupEntry>[] = [
    {
      key: 'file',
      header: 'Backup',
      render: (entry) => (
        <span className="cell-primary">
          <span className="cell-primary__name mono">{entry.filename}</span>
          <span className="cell-primary__meta">
            {entry.kind} · {formatBytes(entry.sizeBytes)}
          </span>
        </span>
      ),
    },
    {
      key: 'integrity',
      header: 'Integrity',
      render: (entry) => (
        <StatusPill label={entry.integrity === 'ok' ? 'ok' : entry.integrity} tone={entry.integrity === 'ok' ? 'success' : 'danger'} />
      ),
    },
    { key: 'created', header: 'Created', align: 'right', muted: true, render: (entry) => relativeFromNow(entry.createdAt) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (entry) => (
        <div className="row-actions">
          <Button
            variant="ghost"
            onClick={() => {
              setPassword('');
              setDownload(entry);
            }}
          >
            Download
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void deleteBackup(entry.id)
                .then(() => {
                  toast.push('Backup deleted', { message: entry.filename, tone: 'success' });
                  void load();
                })
                .catch(() => toast.push('Could not delete the backup', { tone: 'danger' }));
            }}
          >
            Remove
          </Button>
        </div>
      ),
    },
  ];

  const stale = data?.latestAgeHours !== null && data !== null && data.latestAgeHours > 36;

  return (
    <>
      {data && !data.enabled ? (
        <div className="caddy-banner caddy-banner--danger" role="alert">
          <Icon name="alert" size={16} />
          <div className="caddy-banner__text">
            <strong>Backups are disabled</strong>
            <span>BACKUP_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`, add it to .env and restart.</span>
          </div>
        </div>
      ) : null}

      {data && data.enabled && stale ? (
        <div className="caddy-banner caddy-banner--warning" role="status">
          <Icon name="info" size={16} />
          <div className="caddy-banner__text">
            <strong>No recent backup</strong>
            <span>
              The newest backup is {data.latestAgeHours ? Math.round(data.latestAgeHours) : 0}h old (schedule is every{' '}
              {data.scheduleHours}h).
            </span>
          </div>
        </div>
      ) : null}

      <div className="page-toolbar">
        <span className="page-toolbar__spacer" />
        <Button
          variant="primary"
          disabled={busy || !data?.enabled}
          onClick={() => {
            setBusy(true);
            void createBackup()
              .then(({ backup }) => {
                toast.push('Backup created', { message: `${backup.filename} · ${formatBytes(backup.sizeBytes)}`, tone: 'success' });
                void load();
              })
              .catch((err: unknown) =>
                toast.push('Backup failed', {
                  message: err instanceof ApiError ? err.message : 'Unknown error',
                  tone: 'danger',
                }),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>

      {error ? (
        <Card>
          <EmptyState icon="alert" title="Could not load backups" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
        </Card>
      ) : data === null ? (
        <Card flush>
          <div className="ops-skeleton">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} height="64px" />
            ))}
          </div>
        </Card>
      ) : (
        <Card flush>
          <DataTable
            columns={columns}
            rows={data.backups}
            getRowKey={(entry) => entry.id}
            caption="Encrypted database backups"
            empty={
              <EmptyState
                illustration={{ src: backupsEmptiness }}
                title="No backups yet"
                description="Create an encrypted copy of the dashboard database."
                action={
                  data.enabled ? (
                    <Button variant="primary" onClick={() => void createBackup().then(() => void load())}>
                      Back up now
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </Card>
      )}

      <p className="muted ops-note">
        Retention: last {data?.keepDaily ?? 7} daily and {data?.keepWeekly ?? 4} weekly files. Backups never include .env —
        store BACKUP_ENCRYPTION_KEY off this machine or they cannot be restored.
      </p>

      <Modal
        open={download !== null}
        title="Download backup"
        onClose={() => setDownload(null)}
        footer={
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setDownload(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={password.length === 0}
              onClick={() => {
                if (!download) return;
                void downloadBackup(download.id, password)
                  .then((blob) => {
                    const url = URL.createObjectURL(blob);
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = download.filename;
                    anchor.click();
                    URL.revokeObjectURL(url);
                    setDownload(null);
                    toast.push('Download started', { message: download.filename, tone: 'success' });
                  })
                  .catch((err: unknown) =>
                    toast.push('Download refused', {
                      message: err instanceof Error ? err.message : 'Unknown error',
                      tone: 'danger',
                    }),
                  );
              }}
            >
              Download
            </Button>
          </div>
        }
      >
        <p>Re-enter your password. The download is rate limited and audited.</p>
        <input
          className="input"
          type="password"
          autoFocus
          value={password}
          placeholder="Password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </Modal>
    </>
  );
}
