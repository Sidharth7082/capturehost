import { useEffect, useRef, useState } from 'react';
import { dockerStatsSocketUrl, type ContainerStatsSample } from '../api/client';

export interface UseDockerStatsResult {
  stats: Map<string, ContainerStatsSample>;
  connected: boolean;
}

interface StatsFrame {
  type: 'hello' | 'stats';
  payload: {
    ts?: number;
    available?: boolean;
    containers?: ContainerStatsSample[];
    intervalMs?: number;
  };
}

/**
 * One WebSocket for every container's CPU/RAM.
 *
 * The server runs a single shared poller; this hook just receives snapshots and
 * keeps them in a Map keyed by container id so the table can look up its row
 * without re-rendering the world on every frame.
 */
export function useDockerStats(enabled = true): UseDockerStatsResult {
  const [stats, setStats] = useState<Map<string, ContainerStatsSample>>(new Map());
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let closedByUs = false;
    let retry: number | null = null;
    let attempts = 0;

    const connect = (): void => {
      if (closedByUs) return;

      const socket = new WebSocket(dockerStatsSocketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const frame = JSON.parse(event.data) as StatsFrame;
          if (frame.type !== 'stats' || !Array.isArray(frame.payload.containers)) return;

          setStats(new Map(frame.payload.containers.map((sample) => [sample.id, sample])));
        } catch {
          /* ignore malformed frame */
        }
      };

      socket.onclose = (event: CloseEvent) => {
        setConnected(false);
        socketRef.current = null;
        if (closedByUs) return;

        // 1008 = refused (no session / bad origin): do not spin.
        if (event.code === 1008) return;

        attempts += 1;
        retry = window.setTimeout(connect, Math.min(1000 * 2 ** (attempts - 1), 10_000));
      };

      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      closedByUs = true;
      if (retry) window.clearTimeout(retry);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled]);

  return { stats, connected };
}
