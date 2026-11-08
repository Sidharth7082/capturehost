import { useCallback, useEffect, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import { fetchDoctor, type DoctorCheck, type DoctorReport } from '../api/ops';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { Skeleton } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';
import '../styles/ops.css';

/** Security check: the "doctor" page. Pass / warn / fail, with a fix for each. */

const TONE = { pass: 'success', warn: 'warning', fail: 'danger', skip: 'neutral' } as const;

function CheckRow({ check }: { check: DoctorCheck }): JSX.Element {
  return (
    <li className={`check-row check-row--${check.status}`}>
      <StatusPill label={check.status} tone={TONE[check.status]} dot={false} />
      <div className="check-row__body">
        <strong>{check.title}</strong>
        <span className="muted">{check.detail}</span>
        {check.fix ? (
          <span className="check-row__fix">
            <Icon name="info" size={13} /> {check.fix}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function Security(): JSX.Element {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setReport(await fetchDoctor());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the checks');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <>
      <div className="page-toolbar">
        <span className="muted">
          {report
            ? `${report.summary.pass} pass · ${report.summary.warn} warn · ${report.summary.fail} fail`
            : 'running checks…'}
        </span>
        <span className="page-toolbar__spacer" />
        <Button variant="ghost" disabled={busy} onClick={() => void run()}>
          {busy ? 'Checking…' : 'Run again'}
        </Button>
      </div>

      {error ? (
        <Card>
          <p className="form-error">{error}</p>
        </Card>
      ) : report === null ? (
        <Card>
          <div className="ops-skeleton">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} height="48px" />
            ))}
          </div>
        </Card>
      ) : (
        <Card flush>
          <ul className="check-list">
            {report.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </ul>
        </Card>
      )}

      <p className="muted ops-note">
        Same checks from a shell: <span className="mono">npm run doctor</span> in the backend. Nothing here prints a
        secret value — only whether something is set.
      </p>
    </>
  );
}
