import { useCallback, useEffect, useRef, useState } from 'react';
import { metricsSocketUrl, type MetricsSnapshot } from '../api/client';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

interface WsFrame {
  type: 'hello' | 'snapshot' | 'error';
  payload: unknown;
}

export interface UseMetricsSocketResult {
  snapshot: MetricsSnapshot | null;
  status: ConnectionStatus;
  /** Timestamp (ms) of the last frame, or null before the first one. */
  lastMessageAt: number | null;
  /** Consecutive failed connection attempts, for the "reconnecting" hint. */
  attempts: number;
}

const MAX_BACKOFF_MS = 15_000;

/**
 * Live metrics over WebSocket, with exponential-backoff reconnection.
 *
 * The socket is read-only: the server pushes a snapshot every 2 s. If the
 * connection drops (backend restart, laptop sleep) we retry at
 * 1s, 2s, 4s … capped at 15s, and never spin.
 */
export function useMetricsSocket(): UseMetricsSocketResult {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [attempts, setAttempts] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const attemptsRef = useRef(0);
  const closedByUsRef = useRef(false);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    closedByUsRef.current = false;

    const connect = (): void => {
      if (closedByUsRef.current) return;

      const socket = new WebSocket(metricsSocketUrl());
      socketRef.current = socket;
      setStatus(attemptsRef.current === 0 ? 'connecting' : 'reconnecting');

      socket.onopen = () => {
        attemptsRef.current = 0;
        setAttempts(0);
        setStatus('live');
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const frame = JSON.parse(event.data) as WsFrame;
          if (frame.type === 'snapshot') {
            setSnapshot(frame.payload as MetricsSnapshot);
            setLastMessageAt(Date.now());
          }
        } catch {
          // A malformed frame is not worth tearing the connection down for.
        }
      };

      socket.onclose = (event: CloseEvent) => {
        socketRef.current = null;
        if (closedByUsRef.current) return;

        // 1008 is the server refusing us deliberately — no session, or an
        // Origin that is not allowlisted. Retrying would loop forever (and,
        // after a logout, hammer a closed door), so stop and report offline.
        if (event.code === 1008) {
          setStatus('offline');
          return;
        }

        attemptsRef.current += 1;
        setAttempts(attemptsRef.current);
        setStatus('reconnecting');

        const delay = Math.min(1000 * 2 ** (attemptsRef.current - 1), MAX_BACKOFF_MS);
        clearRetry();
        retryTimerRef.current = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        // onclose always follows; let it own the retry so we never double-schedule.
        socket.close();
      };
    };

    connect();

    return () => {
      closedByUsRef.current = true;
      clearRetry();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [clearRetry]);

  return { snapshot, status, lastMessageAt, attempts };
}
