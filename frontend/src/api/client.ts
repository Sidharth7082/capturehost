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

/**
 * CSRF token for state-changing requests.
 *
 * Held in memory only (never localStorage): it is useless without the httpOnly
 * session cookie, and keeping it out of storage means an XSS bug cannot lift a
 * durable credential. AuthProvider sets it after every login/refresh.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/**
 * Called on any 401 from a non-login endpoint: the session is gone (logout,
 * expiry, or revoked elsewhere), so the shell must return to /login.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  if (!SAFE_METHODS.has(method) && csrfToken) {
    headers['x-csrf-token'] = csrfToken;
  }

  let response: Response;

  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      method,
      headers,
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

    // Only a genuine "no valid session" forces a logout. A 401 from a failed
    // action (wrong password, bad TOTP code) must not eject the user.
    if (response.status === 401 && body.code === 'unauthenticated') {
      onUnauthorized?.();
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

// ---------------------------------------------------------------- auth API

export interface MeResponse {
  username: string;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  passwordChangedAt: number | null;
  csrfToken: string;
}

export interface LoginResponse {
  requires2fa: boolean;
  username: string;
  csrfToken: string;
}

export interface SetupStatusResponse {
  setupComplete: boolean;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface TotpSetupResponse {
  secret: string;
  uri: string;
  qrDataUrl: string;
}

export interface AuditEntry {
  id: number;
  ts: number;
  action: string;
  actor: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  success: number;
}

export interface AuditPageResponse {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function fetchMe(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/api/auth/me');
}

export function fetchSetupStatus(): Promise<SetupStatusResponse> {
  return apiFetch<SetupStatusResponse>('/api/auth/setup-status');
}

export function loginWithPassword(username: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export function verifyTwoFactor(code: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/login/2fa', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export function logoutRequest(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; revokedSessions: number }> {
  return apiFetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function fetchSessions(): Promise<{ sessions: SessionInfo[] }> {
  return apiFetch<{ sessions: SessionInfo[] }>('/api/auth/sessions');
}

export function revokeSession(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function revokeOtherSessions(): Promise<{ ok: boolean; revokedSessions: number }> {
  return apiFetch('/api/auth/sessions/revoke-others', { method: 'POST' });
}

export function startTotpSetup(): Promise<TotpSetupResponse> {
  return apiFetch<TotpSetupResponse>('/api/auth/2fa/setup', { method: 'POST' });
}

export function confirmTotp(code: string): Promise<{ recoveryCodes: string[] }> {
  return apiFetch<{ recoveryCodes: string[] }>('/api/auth/2fa/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export function disableTotp(password: string, code: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>('/api/auth/2fa/disable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, code }),
  });
}

export function fetchAudit(limit = 10, offset = 0): Promise<AuditPageResponse> {
  return apiFetch<AuditPageResponse>(`/api/audit?limit=${limit}&offset=${offset}`);
}
