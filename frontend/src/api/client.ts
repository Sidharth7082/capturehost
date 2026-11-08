/**
 * Typed access to the backend. One place that knows about URLs, JSON and
 * error shapes, so components never call fetch() directly.
 */

export type HistoryRange = '1h' | '6h' | '24h';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  db: 'ok' | 'error';
  timestamp: string;
}

export interface HistoryPoint {
  bucketTs: number;
  cpuPct: number;
  memPct: number;
  diskPct: number;
  netRxBps: number;
  netTxBps: number;
  gpuUtilPct: number | null;
}

export interface HistoryResponse {
  range: HistoryRange;
  bucketSeconds: number;
  from: string;
  to: string;
  truncated: boolean;
  points: HistoryPoint[];
}

/** Mirrors the backend MetricsSnapshot exactly. */
export interface MetricsSnapshot {
  ts: number;
  cpuPct: number;
  memUsedBytes: number;
  memTotalBytes: number;
  memPct: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskPct: number;
  netRxBps: number;
  netTxBps: number;
  gpuUtilPct: number | null;
  gpuMemUsedMb: number | null;
  gpuMemTotalMb: number | null;
  gpuTempC: number | null;
  uptimeSeconds: number;
}

interface ApiErrorBody {
  error?: string;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
  } catch {
    // Network-level failure: the backend is probably not running.
    throw new ApiError(0, 'network_error', 'Cannot reach the CaptureHost backend');
  }

  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      /* non-JSON error body — fall through to the generic message */
    }
    throw new ApiError(
      response.status,
      body.code ?? 'http_error',
      body.error ?? `Request failed with status ${response.status}`,
    );
  }

  return (await response.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/api/health');
}

export function fetchHistory(range: HistoryRange, signal?: AbortSignal): Promise<HistoryResponse> {
  return apiFetch<HistoryResponse>(`/api/metrics/history?range=${range}`, { signal });
}

/** WebSocket URL for the live metrics channel, on the current origin. */
export function metricsSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/metrics`;
}
