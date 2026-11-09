import { useCallback, useEffect, useState, type JSX } from 'react';
import { ApiError, apiFetch } from '../../api/client';
import { Button } from '../../components/Button';

/**
 * The Dockerfile card on a project's Overview tab.
 *
 * CaptureHost can suggest a Dockerfile by reading the repository's manifests, then
 * store it for deploys. The rule that keeps this unsurprising: **the repository's
 * own Dockerfile always wins** — a stored one is only written into a clone when the
 * repository has nothing at the configured path.
 */

interface Suggestion {
  stack: string;
  dockerfile: string;
  notes: string[];
  confidence: 'high' | 'medium' | 'low';
}

interface StoredDockerfile {
  content: string;
  source: 'generated' | 'edited';
  updatedAt: number;
}

export function DockerfileCard({
  projectId,
  dockerfilePath,
  onDeploy,
}: {
  projectId: number;
  dockerfilePath: string;
  onDeploy: () => void;
}): JSX.Element {
  const [stored, setStored] = useState<StoredDockerfile | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<{ override: StoredDockerfile | null }>(`/api/projects/${projectId}/dockerfile`);
      setStored(result.override);
    } catch {
      /* the card simply shows nothing; the project page is the error surface */
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const suggest = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ suggestion: Suggestion | null; reason?: string }>(
        `/api/projects/${projectId}/dockerfile/suggest`,
        { method: 'POST' },
      );
      if (!result.suggestion) {
        setError(result.reason ?? 'No stack recognised in this repository.');
        return;
      }
      setSuggestion(result.suggestion);
      setDraft(result.suggestion.dockerfile);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not read the repository');
    } finally {
      setBusy(false);
    }
  };

  const save = async (source: 'generated' | 'edited'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ override: StoredDockerfile }>(`/api/projects/${projectId}/dockerfile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: draft, source }),
      });
      setStored(result.override);
      setSuggestion(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the Dockerfile');
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    try {
      await apiFetch(`/api/projects/${projectId}/dockerfile`, { method: 'DELETE' });
      setStored(null);
      setDraft('');
      setSuggestion(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove it');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card df-card">
      <header className="card__head">
        <div>
          <h2 className="card__title">Dockerfile</h2>
          <p className="card__subtitle">
            Read from <code>{dockerfilePath}</code> in the repository, or generated here when there is none.
          </p>
        </div>
      </header>

      {stored ? (
        <div className="df-state">
          <span className="df-state__badge">
            stored · {stored.source} · {stored.content.split('\n').length} lines
          </span>
          <span className="df-state__note">The repository’s own Dockerfile wins if it has one.</span>
          <Button variant="ghost" onClick={() => void clear()} disabled={busy}>
            Remove
          </Button>
        </div>
      ) : suggestion ? null : (
        <div className="df-state">
          <span className="df-state__badge df-state__badge--empty">not stored</span>
          <span className="df-state__note">A repository without a Dockerfile cannot deploy.</span>
        </div>
      )}

      {error ? <div className="form-error">{error}</div> : null}

      {suggestion ? (
        <div className="df-suggestion">
          <div className="df-suggestion__head">
            <strong>{suggestion.stack}</strong>
            <span className={`df-confidence df-confidence--${suggestion.confidence}`}>
              {suggestion.confidence} confidence
            </span>
          </div>
          <textarea
            className="df-editor"
            spellCheck={false}
            value={draft}
            rows={Math.min(22, Math.max(8, draft.split('\n').length + 1))}
            onChange={(event) => setDraft(event.target.value)}
          />
          <ul className="df-notes">
            {suggestion.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <div className="df-actions">
            <Button variant="primary" disabled={busy} onClick={() => void save('generated')}>
              Save and use for deploys
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setSuggestion(null)}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="df-actions">
          <Button variant="ghost" disabled={busy} onClick={() => void suggest()}>
            {busy ? 'Reading the repository…' : 'Suggest a Dockerfile'}
          </Button>
          {stored ? (
            <Button variant="primary" disabled={busy} onClick={onDeploy}>
              Deploy with it
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
