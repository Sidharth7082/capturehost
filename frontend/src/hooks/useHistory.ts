import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHistory, type HistoryRange, type HistoryResponse } from '../api/client';

export type HistoryStatus = 'loading' | 'ready' | 'error';

export interface UseHistoryResult {
  data: HistoryResponse | null;
  status: HistoryStatus;
  error: string | null;
  refetch: () => void;
}

/** History is slow-moving; 30 s is plenty and keeps load off SQLite. */
const REFRESH_MS = 30_000;

/**
 * Fetches bucketed history for a range and refreshes it periodically.
 * Aborts the in-flight request when the range changes, so the chart never
 * shows a stale window.
 */
export function useHistory(range: HistoryRange): UseHistoryResult {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [status, setStatus] = useState<HistoryStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  const refetch = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;

    const load = async (showSpinner: boolean): Promise<void> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (showSpinner) setStatus((current) => (current === 'ready' ? 'ready' : 'loading'));

      try {
        const response = await fetchHistory(range, controller.signal);
        if (cancelled) return;
        setData(response);
        setError(null);
        setStatus('ready');
      } catch (caught) {
        if (cancelled || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : 'Failed to load history');
        setStatus('error');
      }
    };

    void load(true);
    const timer = window.setInterval(() => void load(false), REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      controllerRef.current?.abort();
    };
  }, [range, nonce]);

  return { data, status, error, refetch };
}
