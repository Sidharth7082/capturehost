import { useCallback, useEffect, useState, type JSX } from 'react';
import { ApiError } from '../../api/client';
import {
  connectGithub,
  disconnectGithub,
  fetchGithubStatus,
  type GithubStatus,
} from '../../api/github';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Skeleton } from '../../components/Skeleton';
import { StatusPill } from '../../components/StatusPill';
import { relativeFromNow } from '../../utils/format';
import './GithubSection.css';

/**
 * Settings → Integrations → GitHub.
 *
 * The token field is write-only in the strict sense: it is typed once, POSTed, and
 * then forgotten by this component. Nothing here ever receives a token back, so
 * there is no code path that could render one.
 */
export function GithubSection(): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [state, setState] = useState<GithubStatus | null>(null);
  const [token, setToken] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await fetchGithubStatus());
      setStatus('ready');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the integration');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await connectGithub(token.trim(), expiresAt.trim() === '' ? null : expiresAt.trim());
      setState(next);
      setToken('');
      setNotice(`Connected to GitHub as ${next.login ?? 'your account'}.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not validate that token');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await disconnectGithub();
      setState(await fetchGithubStatus());
      setNotice('Disconnected. The stored token was deleted.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not disconnect');
    } finally {
      setBusy(false);
    }
  };

  const expiryTone = (): 'success' | 'warning' | 'danger' | 'neutral' => {
    if (!state?.expiresAt) return 'neutral';
    const days = state.daysUntilExpiry ?? 0;
    if (days < 0) return 'danger';
    return days <= 14 ? 'warning' : 'success';
  };

  return (
    <Card
      title="Integrations · GitHub"
      subtitle="Read-only. Pick repositories when creating a project instead of pasting URLs."
    >
      {status === 'loading' ? (
        <div className="github-integration__loading">
          <Skeleton height="16px" />
          <Skeleton height="16px" width="70%" />
          <Skeleton height="16px" width="45%" />
        </div>
      ) : null}

      {status === 'error' ? <div className="form-error">{error}</div> : null}

      {status === 'ready' && state?.connected ? (
        <div className="github-integration">
          <div className="security-row">
            <span className="security-row__label">Status</span>
            <span className="security-row__value">
              <StatusPill label="Connected" tone="success" />
            </span>
          </div>
          <div className="security-row">
            <span className="security-row__label">Account</span>
            <span className="security-row__value github-integration__mono">{state.login}</span>
          </div>
          <div className="security-row">
            <span className="security-row__label">Token expiry</span>
            <span className="security-row__value">
              {state.expiresAt ? (
                <StatusPill
                  label={
                    (state.daysUntilExpiry ?? 0) < 0
                      ? 'Expired'
                      : `${new Date(state.expiresAt).toISOString().slice(0, 10)} · ${state.daysUntilExpiry} day(s) left`
                  }
                  tone={expiryTone()}
                  dot={false}
                />
              ) : (
                <span className="github-integration__muted">
                  not recorded — GitHub does not expose it
                </span>
              )}
            </span>
          </div>
          <div className="security-row">
            <span className="security-row__label">Last validated</span>
            <span className="security-row__value">
              {state.lastValidatedAt ? relativeFromNow(state.lastValidatedAt) : '—'}
            </span>
          </div>
          <div className="security-row">
            <span className="security-row__label">Endpoint</span>
            <span className="security-row__value github-integration__mono">https://{state.apiHost}</span>
          </div>

          {state.lastError ? <div className="form-error">{state.lastError}</div> : null}
          {notice ? <div className="form-notice">{notice}</div> : null}

          <div className="github-integration__actions">
            <Button variant="ghost" disabled={busy} onClick={() => void disconnect()}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
            <span className="github-integration__hint">
              Disconnecting deletes the token. Projects keep their own tokens.
            </span>
          </div>
        </div>
      ) : null}

      {status === 'ready' && !state?.connected ? (
        <div className="github-integration">
          <p className="form-hint github-integration__intro">
            Paste a <strong>fine-grained personal access token</strong> with read-only access
            (<code>Contents: Read</code> and <code>Metadata: Read</code>). CaptureHost never writes to
            GitHub. The token is stored encrypted with the app key and is never returned by the API or
            written to a log.
          </p>

          <label className="field">
            <span className="field__label">Personal access token</span>
            <input
              className="input"
              type="password"
              value={token}
              placeholder="github_pat_…"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setToken(event.target.value)}
            />
            <span className="field__hint">
              Validated against GET /user before it is stored. Shown once, here, and never again.
            </span>
          </label>

          <label className="field">
            <span className="field__label">Expiry (optional)</span>
            <input
              className="input"
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
            <span className="field__hint">
              GitHub does not report it, so record it here to get a warning 14 days before it lapses.
            </span>
          </label>

          {error ? <div className="form-error">{error}</div> : null}
          {notice ? <div className="form-notice">{notice}</div> : null}

          <div className="github-integration__actions">
            <Button variant="primary" disabled={busy || token.trim() === ''} onClick={() => void connect()}>
              {busy ? 'Validating…' : 'Connect GitHub'}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
