import { useCallback, useEffect, useState, type JSX } from 'react';
import { ApiError, apiFetch } from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { StatusPill } from '../../components/StatusPill';
import { relativeFromNow } from '../../utils/format';
import './AgentSection.css';

/**
 * Settings → Agent access.
 *
 * Issues bearer tokens for an external agent. The token is shown **once**, in the
 * response that creates it; this component never receives it again, and the list
 * below carries only a name, a permission and timestamps.
 */

interface AgentToken {
  id: number;
  name: string;
  allowDeploy: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

const TOOLS = [
  'whoami',
  'list_projects',
  'get_project',
  'read_deployment',
  'deploy_project',
  'run_doctor',
];

export function AgentSection(): JSX.Element {
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [name, setName] = useState('');
  const [allowDeploy, setAllowDeploy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<{ tokens: AgentToken[] }>('/api/agent/tokens');
      setTokens(result.tokens);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load tokens');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ token: string; tokens: AgentToken[] }>('/api/agent/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), allowDeploy }),
      });
      setFresh(result.token);
      setTokens(result.tokens);
      setName('');
      setAllowDeploy(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the token');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ tokens: AgentToken[] }>(`/api/agent/tokens/${id}`, { method: 'DELETE' });
      setTokens(result.tokens);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke the token');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Agent access" subtitle="A fixed list of verbs for an external agent — not a shell.">
      <p className="form-hint agent-intro">
        A token lets an agent (this machine's assistant, a script, a CI job) ask CaptureHost to do what
        CaptureHost already does: list projects, read a build log and its diagnosis, run the doctor, and —
        only if you allow it — start a deploy. There is no shell, no filesystem read and no Docker
        passthrough. Every call is audited as <code>agent.&lt;tool&gt;</code> with the token's name.
      </p>

      <div className="agent-tools">
        {TOOLS.map((tool) => (
          <span key={tool} className="agent-tools__item">
            {tool}
          </span>
        ))}
      </div>

      {fresh ? (
        <div className="agent-fresh">
          <div className="agent-fresh__head">Token — shown once, copy it now</div>
          <code className="agent-fresh__value">{fresh}</code>
          <div className="agent-fresh__actions">
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(fresh)}>
              Copy
            </Button>
            <Button variant="ghost" onClick={() => setFresh(null)}>
              I have saved it
            </Button>
          </div>
          <p className="agent-fresh__hint">
            Use it as <code>Authorization: Bearer …</code>. It cannot be shown again; revoke and create a new
            one if you lose it.
          </p>
        </div>
      ) : null}

      <div className="agent-form">
        <label className="field">
          <span className="field__label">Token name</span>
          <input
            className="input"
            value={name}
            placeholder="hermes"
            onChange={(event) => setName(event.target.value)}
          />
          <span className="field__hint">Appears in the audit log as “agent:&lt;name&gt;”.</span>
        </label>

        <label className="agent-checkbox">
          <input type="checkbox" checked={allowDeploy} onChange={(event) => setAllowDeploy(event.target.checked)} />
          <span>
            Allow this token to start deployments
            <span className="field__hint">Without this it can only read.</span>
          </span>
        </label>

        <Button variant="primary" disabled={busy || name.trim().length < 2} onClick={() => void create()}>
          {busy ? 'Creating…' : 'Create token'}
        </Button>
      </div>

      {error ? <div className="form-error">{error}</div> : null}

      {tokens.length > 0 ? (
        <ul className="agent-tokens">
          {tokens.map((token) => (
            <li key={token.id} className={`agent-tokens__row${token.revoked ? ' agent-tokens__row--revoked' : ''}`}>
              <span className="agent-tokens__name">{token.name}</span>
              <StatusPill
                label={token.revoked ? 'revoked' : token.allowDeploy ? 'read + deploy' : 'read only'}
                tone={token.revoked ? 'neutral' : token.allowDeploy ? 'warning' : 'success'}
                dot={false}
              />
              <span className="agent-tokens__when">
                {token.lastUsedAt ? `used ${relativeFromNow(token.lastUsedAt)}` : 'never used'}
              </span>
              {token.revoked ? null : (
                <Button variant="ghost" disabled={busy} onClick={() => void revoke(token.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="agent-empty">No tokens yet.</p>
      )}
    </Card>
  );
}
