import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  ApiError,
  fetchSessions,
  revokeOtherSessions,
  revokeSession,
  type SessionInfo,
} from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/Skeleton';
import { StatusPill } from '../../components/StatusPill';
import { relativeFromNow } from '../../utils/format';

/** Short, human label for a User-Agent string. */
function describeAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown client';
  const browser = /Firefox\//.test(userAgent)
    ? 'Firefox'
    : /Edg\//.test(userAgent)
      ? 'Edge'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS X/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Linux/.test(userAgent)
          ? 'Linux'
          : '';
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Active sessions with per-session revocation.
 *
 * Every row is a real server-side session. Revoking one closes its WebSockets
 * immediately, so "revoke" means revoked, not "next page load".
 */
export function SessionsSection(): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchSessions();
      setSessions(result.sessions);
      setStatus('ready');
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load sessions');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await revokeSession(id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke the session');
    } finally {
      setBusyId(null);
    }
  };

  const revokeAllOthers = async (): Promise<void> => {
    setBusyId('others');
    try {
      await revokeOtherSessions();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke sessions');
    } finally {
      setBusyId(null);
    }
  };

  const others = sessions.filter((session) => !session.current).length;

  return (
    <Card
      title="Active sessions"
      subtitle="Signing out a session ends its socket immediately"
      actions={
        others > 0 ? (
          <Button size="sm" variant="danger" onClick={() => void revokeAllOthers()} disabled={busyId !== null}>
            Revoke others ({others})
          </Button>
        ) : undefined
      }
    >
      {status === 'loading' && <Skeleton height="64px" />}

      {status === 'error' && (
        <EmptyState variant="error" title="Could not load sessions" description={error ?? undefined} />
      )}

      {status === 'ready' && sessions.length === 0 && <EmptyState title="No sessions" description="Sign in again to create one." />}

      {status === 'ready' &&
        sessions.map((session) => (
          <div className="session-item" key={session.id}>
            <span className="session-item__icon">
              <Icon name="logs" size={15} />
            </span>
            <div className="session-item__body">
              <div className="session-item__title">
                {describeAgent(session.userAgent)}
                {session.current && <StatusPill label="this device" tone="success" />}
              </div>
              <div className="session-item__meta">
                {session.ip ?? 'unknown ip'} · seen {relativeFromNow(session.lastSeenAt)} · started{' '}
                {relativeFromNow(session.createdAt)}
              </div>
            </div>
            {!session.current && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void revoke(session.id)}
                disabled={busyId !== null}
              >
                {busyId === session.id ? 'Revoking…' : 'Revoke'}
              </Button>
            )}
          </div>
        ))}
    </Card>
  );
}
