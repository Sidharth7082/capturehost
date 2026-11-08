import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchContainers,
  fetchDockerStatus,
  type ContainerSummary,
  type DockerStatus,
} from '../api/client';

export interface UseContainersResult {
  containers: ContainerSummary[];
  status: DockerStatus | null;
  /** True when the proxy is unreachable: the page shows a banner, not an error. */
  unavailable: boolean;
  error: string | null;
  loading: boolean;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
}

/** How often the table re-lists containers (stats come over the WebSocket). */
const POLL_MS = 10_000;

/**
 * Container list + engine status.
 *
 * The list is the source of truth for *what exists* (names, states, ports); the
 * live CPU/RAM numbers arrive separately on /ws/docker/stats and are merged by
 * id, so a stats hiccup never blanks the table.
 */
export function useContainers(): UseContainersResult {
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const [list, engine] = await Promise.all([fetchContainers(), fetchDockerStatus()]);
      setContainers(list.containers);
      setStatus(engine);
      setUnavailable(false);
      setError(null);
      setLastUpdated(Date.now());
    } catch (caught) {
      // A 503 from the proxy is an expected state, not a bug: keep the last
      // list on screen and let the banner explain it.
      if (caught instanceof ApiError && caught.status === 503) {
        setUnavailable(true);
        setError(caught.message);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Could not load containers');
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { containers, status, unavailable, error, loading, lastUpdated, refresh };
}
