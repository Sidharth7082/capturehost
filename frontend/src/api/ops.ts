import { apiFetch, getCsrfToken } from './client';

/** Phase 6: backups, notifications and the security doctor. */

export interface BackupEntry {
  id: number;
  filename: string;
  sizeBytes: number;
  kind: 'scheduled' | 'manual';
  integrity: string;
  createdAt: number;
}

export interface BackupList {
  enabled: boolean;
  scheduleHours: number;
  keepDaily: number;
  keepWeekly: number;
  latestAgeHours: number | null;
  backups: BackupEntry[];
}

export interface NotificationEntry {
  id: number;
  event: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string | null;
  createdAt: number;
  readAt: number | null;
}

export interface DoctorCheck {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ranAt: number;
  summary: { pass: number; warn: number; fail: number; skip: number };
  checks: DoctorCheck[];
}

export function fetchBackups(): Promise<BackupList> {
  return apiFetch('/api/backups');
}

export function createBackup(): Promise<{ backup: { filename: string; sizeBytes: number; sha256: string } }> {
  return apiFetch('/api/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function deleteBackup(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/backups/${id}`, { method: 'DELETE' });
}

/** Downloading re-checks the password server side; the key never leaves the box. */
export async function downloadBackup(id: number, password: string): Promise<Blob> {
  const token = getCsrfToken();
  const response = await fetch(`/api/backups/${id}/download`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-csrf-token': token } : {}),
    },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    let message = 'Download failed';
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      /* non-JSON */
    }
    throw new Error(message);
  }

  return response.blob();
}

export function fetchNotifications(
  limit = 50,
): Promise<{ unread: number; notifications: NotificationEntry[] }> {
  return apiFetch(`/api/notifications?limit=${limit}`);
}

export function markNotificationsRead(ids: number[] | 'all'): Promise<{ ok: boolean; changed: number }> {
  return apiFetch('/api/notifications/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export function fetchChannel(): Promise<{ configured: boolean; host: string | null; cooldownMinutes: number }> {
  return apiFetch('/api/notifications/channel');
}

export function sendTestNotification(): Promise<{ ok: boolean }> {
  return apiFetch('/api/notifications/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function fetchDoctor(): Promise<DoctorReport> {
  return apiFetch('/api/doctor');
}
