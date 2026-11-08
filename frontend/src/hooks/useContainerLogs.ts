import { useCallback, useEffect, useRef, useState } from 'react';
import { dockerLogsSocketUrl } from '../api/client';

export interface LogLine {
  /** Monotonic id, used as the React key (lines repeat verbatim). */
  n: number;
  text: string;
}

export interface UseContainerLogsResult {
  lines: LogLine[];
  connected: boolean;
  ended: boolean;
  error: string | null;
  /** Frames the server dropped because this client could not keep up. */
  dropped: number;
  paused: boolean;
  togglePause: () => void;
  clear: () => void;
  containerName: string | null;
}

/** Hard cap on retained lines; older ones scroll away. */
const MAX_LINES = 4000;

interface LogFrame {
  type: 'open' | 'line' | 'end' | 'error' | 'dropped';
  payload: { line?: string; message?: string; reason?: string; name?: string; count?: number };
}

/**
 * Live container logs.
 *
 * Pause is local: the socket keeps draining (so the server's backpressure logic
 * sees a healthy client) but lines are buffered in a ref instead of being
 * rendered. Resuming flushes the buffer once.
 */
export function useContainerLogs(containerId: string | null, tail: number): UseContainerLogsResult {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [paused, setPaused] = useState(false);
  const [containerName, setContainerName] = useState<string | null>(null);

  const pausedRef = useRef(false);
  const bufferedRef = useRef<LogLine[]>([]);
  const counterRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);

  const append = useCallback((incoming: LogLine[]) => {
    if (incoming.length === 0) return;
    setLines((current) => {
      const next = [...current, ...incoming];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    if (!containerId) return;

    setLines([]);
    setEnded(false);
    setError(null);
    setDropped(0);
    setConnected(false);
    bufferedRef.current = [];

    const socket = new WebSocket(dockerLogsSocketUrl(containerId, tail));
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);

    socket.onmessage = (event: MessageEvent<string>) => {
      let frame: LogFrame;
      try {
        frame = JSON.parse(event.data) as LogFrame;
      } catch {
        return;
      }

      if (frame.type === 'open') {
        setContainerName(frame.payload.name ?? null);
        return;
      }
      if (frame.type === 'line' && typeof frame.payload.line === 'string') {
        counterRef.current += 1;
        const entry: LogLine = { n: counterRef.current, text: frame.payload.line };

        if (pausedRef.current) {
          bufferedRef.current.push(entry);
          // While paused, keep at most one screenful in the buffer.
          if (bufferedRef.current.length > MAX_LINES) bufferedRef.current.shift();
        } else {
          append([entry]);
        }
        return;
      }
      if (frame.type === 'dropped') {
        setDropped((current) => current + (frame.payload.count ?? 0));
        return;
      }
      if (frame.type === 'end') {
        setEnded(true);
        return;
      }
      if (frame.type === 'error') {
        setError(frame.payload.message ?? 'Log stream failed');
      }
    };

    socket.onclose = () => {
      setConnected(false);
    };

    socket.onerror = () => {
      setConnected(false);
    };

    return () => {
      socket.onclose = null;
      socket.close();
      socketRef.current = null;
    };
  }, [containerId, tail, append]);

  const togglePause = useCallback(() => {
    setPaused((current) => {
      const next = !current;
      pausedRef.current = next;

      if (!next && bufferedRef.current.length > 0) {
        const flush = bufferedRef.current;
        bufferedRef.current = [];
        append(flush);
      }
      return next;
    });
  }, [append]);

  const clear = useCallback(() => {
    bufferedRef.current = [];
    setLines([]);
  }, []);

  return { lines, connected, ended, error, dropped, paused, togglePause, clear, containerName };
}
