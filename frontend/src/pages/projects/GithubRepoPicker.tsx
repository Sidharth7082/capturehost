import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  checkGithubDockerfile,
  fetchGithubRepos,
  type GithubRepo,
  type GithubRepoPage,
} from '../../api/github';
import { Button } from '../../components/Button';
import { Skeleton } from '../../components/Skeleton';
import './GithubRepoPicker.css';

/**
 * Repository picker for the "From GitHub" tab of the new-project dialog.
 *
 * Two deliberate choices:
 *  - search and paging are the server's (the backend owns the ETag cache and the
 *    rate-limit story), so this component only debounces keystrokes;
 *  - the Dockerfile check is lazy and per-selection — one request for the repo the
 *    operator picked, never one per row. A fifty-repo page must not cost fifty
 *    requests.
 */

interface Props {
  onSelect: (repo: GithubRepo) => void;
  selected: GithubRepo | null;
}

type LoadState = 'loading' | 'ready' | 'error';

export function GithubRepoPicker({ onSelect, selected }: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<GithubRepoPage | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<{ message: string; kind: 'not-connected' | 'expired' | 'rate-limited' | 'other' } | null>(
    null,
  );
  const [dockerfile, setDockerfile] = useState<{ fullName: string; exists: boolean | null; error: string | null } | null>(
    null,
  );
  const requestId = useRef(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // One request per pause in typing, not per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setState('loading');
    setError(null);
    try {
      const result = await fetchGithubRepos(debounced, page);
      if (id !== requestId.current) return;
      setData(result);
      setState('ready');
    } catch (caught) {
      if (id !== requestId.current) return;
      const apiError = caught instanceof ApiError ? caught : null;
      const kind =
        apiError?.code === 'github_not_connected'
          ? 'not-connected'
          : apiError?.code === 'github_unauthorized'
            ? 'expired'
            : apiError?.code === 'rate_limited'
              ? 'rate-limited'
              : 'other';
      setError({
        message: apiError?.message ?? 'Could not reach GitHub.',
        kind,
      });
      setState('error');
    }
  }, [debounced, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const select = (repo: GithubRepo): void => {
    onSelect(repo);
  };

  /**
   * One lazy check per selection, including a selection restored from above — so
   * the Dockerfile answer always belongs to the row that is highlighted.
   */
  useEffect(() => {
    const repo = selected;
    if (!repo) {
      setDockerfile(null);
      return;
    }

    const [owner, name] = repo.fullName.split('/');
    if (!owner || !name) {
      setDockerfile({ fullName: repo.fullName, exists: null, error: 'Could not parse that repository name' });
      return;
    }

    let cancelled = false;
    setDockerfile({ fullName: repo.fullName, exists: null, error: null });

    void checkGithubDockerfile(owner, name)
      .then((result) => {
        if (!cancelled) setDockerfile({ fullName: repo.fullName, exists: result.exists, error: null });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setDockerfile({
          fullName: repo.fullName,
          exists: null,
          error: caught instanceof ApiError ? caught.message : 'Could not check for a Dockerfile',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const repos = useMemo(() => data?.repos ?? [], [data]);

  // A restored selection can sit below the fold of a 260 px list; bring it into
  // view once the rows exist, without stealing the scroll while the operator browses.
  useEffect(() => {
    if (!selected) return;
    const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected, repos]);

  return (
    <div className="repo-picker">
      <div className="repo-picker__search">
        <input
          className="input"
          type="search"
          value={query}
          placeholder="Search your repositories…"
          aria-label="Search repositories"
          onChange={(event) => setQuery(event.target.value)}
        />
        {data?.cached ? <span className="repo-picker__cached">cached</span> : null}
      </div>

      {state === 'loading' ? (
        <div className="repo-picker__list">
          {[0, 1, 2].map((row) => (
            <div key={row} className="repo-picker__skeleton">
              <Skeleton height="14px" width="40%" />
              <Skeleton height="12px" width="70%" />
            </div>
          ))}
        </div>
      ) : null}

      {state === 'error' && error ? (
        <div className="repo-picker__notice">
          {error.kind === 'not-connected' ? (
            <>
              <strong>GitHub is not connected.</strong>
              <span>
                Connect a read-only token in <Link to="/settings">Settings → Integrations</Link> to pick
                repositories here.
              </span>
            </>
          ) : null}
          {error.kind === 'expired' ? (
            <>
              <strong>The GitHub token is no longer valid.</strong>
              <span>
                GitHub rejected it — it may have expired or been revoked. Reconnect it in{' '}
                <Link to="/settings">Settings → Integrations</Link>.
              </span>
            </>
          ) : null}
          {error.kind === 'rate-limited' ? (
            <>
              <strong>GitHub's rate limit is exhausted.</strong>
              <span>{error.message} Pasting a repository URL still works.</span>
            </>
          ) : null}
          {error.kind === 'other' ? (
            <>
              <strong>Could not load repositories.</strong>
              <span>{error.message}</span>
            </>
          ) : null}
          <Button variant="ghost" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      {state === 'ready' && repos.length === 0 ? (
        <div className="repo-picker__notice">
          <strong>{debounced === '' ? 'No repositories visible' : `No repositories match “${debounced}”`}</strong>
          <span>
            {debounced === ''
              ? 'The token sees no repositories. A fine-grained token needs the repositories selected under “Repository access”.'
              : 'Try a shorter search term, or paste the URL instead.'}
          </span>
        </div>
      ) : null}

      {state === 'ready' && repos.length > 0 ? (
        <ul className="repo-picker__list" role="listbox" aria-label="Repositories" ref={listRef}>
          {repos.map((repo) => {
            const isSelected = selected?.fullName === repo.fullName;
            return (
              <li key={repo.fullName}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`repo-picker__row${isSelected ? ' repo-picker__row--selected' : ''}`}
                  onClick={() => select(repo)}
                >
                  <span className="repo-picker__name">
                    {repo.fullName}
                    {repo.private ? <span className="badge badge--private">private</span> : null}
                    {repo.fork ? <span className="badge">fork</span> : null}
                    {repo.archived ? <span className="badge badge--warn">archived</span> : null}
                  </span>
                  {repo.description ? <span className="repo-picker__desc">{repo.description}</span> : null}
                  <span className="repo-picker__meta">
                    {repo.language ? <span>{repo.language}</span> : null}
                    <span>branch {repo.defaultBranch}</span>
                    {repo.updatedAt ? <span>updated {repo.updatedAt.slice(0, 10)}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {state === 'ready' && (page > 1 || data?.hasMore) ? (
        <div className="repo-picker__pager">
          <Button variant="ghost" disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            Previous
          </Button>
          <span className="repo-picker__page">
            page {page}
            {data?.totalCount !== null && data?.totalCount !== undefined ? ` · ${data.totalCount} found` : ''}
          </span>
          <Button variant="ghost" disabled={!data?.hasMore} onClick={() => setPage((value) => value + 1)}>
            Next
          </Button>
        </div>
      ) : null}

      {dockerfile ? (
        <div className="repo-picker__dockerfile">
          {dockerfile.error ? (
            <span className="repo-picker__dockerfile-bad">{dockerfile.error}</span>
          ) : dockerfile.exists === null ? (
            <span>Checking {dockerfile.fullName} for a Dockerfile…</span>
          ) : dockerfile.exists ? (
            <span className="repo-picker__dockerfile-ok">Dockerfile found at the repository root</span>
          ) : (
            <span className="repo-picker__dockerfile-bad">
              No Dockerfile at the root of {dockerfile.fullName} — the build will fail until you add one
            </span>
          )}
        </div>
      ) : null}

      {selected?.private ? (
        <p className="repo-picker__warning">
          Deploying a private repository runs its code on this machine. Only connect repositories you
          trust — the build is not sandboxed.
        </p>
      ) : null}
    </div>
  );
}
