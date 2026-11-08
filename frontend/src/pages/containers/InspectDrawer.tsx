import { useEffect, useState, type JSX } from 'react';
import { ApiError, fetchContainerInspect, type ContainerInspect } from '../../api/client';
import { Drawer } from '../../components/Drawer';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { StatusPill, toneForStatus } from '../../components/StatusPill';
import { formatBytes, relativeFromNow } from '../../utils/format';

export interface InspectDrawerProps {
  containerId: string | null;
  onClose: () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="inspect-field">
      <span className="inspect-field__label">{label}</span>
      <span className="inspect-field__value">{children}</span>
    </div>
  );
}

/** Read-only container detail. Environment variables appear as KEY NAMES only. */
export function InspectDrawer({ containerId, onClose }: InspectDrawerProps): JSX.Element {
  const [data, setData] = useState<ContainerInspect | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerId) {
      setData(null);
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('loading');

    fetchContainerInspect(containerId)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setStatus('ready');
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : 'Could not inspect the container');
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [containerId]);

  return (
    <Drawer
      open={containerId !== null}
      onClose={onClose}
      title={data ? `Inspect — ${data.name}` : 'Inspect'}
      subtitle={data?.image}
      actions={
        data ? (
          <StatusPill label={data.state.status} tone={toneForStatus(data.state.status)} />
        ) : undefined
      }
    >
      {status === 'loading' && (
        <div style={{ display: 'grid', gap: 10 }}>
          <Skeleton height="16px" />
          <Skeleton height="16px" />
          <Skeleton height="16px" />
          <Skeleton height="16px" />
        </div>
      )}

      {status === 'error' && <EmptyState variant="error" title="Could not inspect" description={error ?? undefined} />}

      {status === 'ready' && data && (
        <div className="inspect">
          <section>
            <h3 className="inspect__heading">Overview</h3>
            <Field label="ID">{data.shortId}</Field>
            <Field label="Image">{data.image}</Field>
            <Field label="Created">{relativeFromNow(data.created)}</Field>
            <Field label="Restart policy">
              {data.config.restartPolicy.name}
              {data.config.restartPolicy.maximumRetryCount > 0
                ? ` (max ${data.config.restartPolicy.maximumRetryCount})`
                : ''}
            </Field>
            <Field label="Command">{[data.config.entrypoint, ...data.config.cmd].filter(Boolean).join(' ')}</Field>
            {data.protected && <Field label="Protection">{data.protectedReason}</Field>}
          </section>

          <section>
            <h3 className="inspect__heading">Ports</h3>
            {data.ports.length === 0 && <p className="inspect__empty">No published ports</p>}
            {data.ports.map((port) => (
              <Field key={`${port.privatePort}-${port.type}`} label={`${port.privatePort}/${port.type}`}>
                {port.publicPort === null ? 'internal only' : `→ host ${port.publicPort}`}
              </Field>
            ))}
          </section>

          <section>
            <h3 className="inspect__heading">Mounts</h3>
            {data.mounts.length === 0 && <p className="inspect__empty">No mounts</p>}
            {data.mounts.map((mount) => (
              <Field key={mount.destination} label={mount.readOnly ? 'ro' : 'rw'}>
                <span className="mono">{mount.source}</span> → <span className="mono">{mount.destination}</span>
              </Field>
            ))}
          </section>

          <section>
            <h3 className="inspect__heading">Networks</h3>
            {data.networks.length === 0 && <p className="inspect__empty">No networks</p>}
            {data.networks.map((network) => (
              <Field key={network.name} label={network.name}>
                {network.ipAddress ?? '—'}
              </Field>
            ))}
          </section>

          <section>
            <h3 className="inspect__heading">Environment (names only)</h3>
            <p className="inspect__empty" style={{ marginBottom: 8 }}>
              Values are never sent to the browser — they usually hold credentials.
            </p>
            <div className="inspect-env">
              {data.config.envKeys.length === 0 && <span className="inspect__empty">No environment variables</span>}
              {data.config.envKeys.map((key) => (
                <span className="inspect-env__key mono" key={key}>
                  {key}
                </span>
              ))}
            </div>
          </section>

          {Object.keys(data.config.labels).length > 0 && (
            <section>
              <h3 className="inspect__heading">Labels</h3>
              {Object.entries(data.config.labels).map(([key, value]) => (
                <Field key={key} label={key}>
                  {value || '—'}
                </Field>
              ))}
            </section>
          )}

          <p className="inspect__empty">
            Memory limit reported by the engine is {formatBytes(0)} when unlimited; live usage is on the table row.
          </p>
        </div>
      )}
    </Drawer>
  );
}
