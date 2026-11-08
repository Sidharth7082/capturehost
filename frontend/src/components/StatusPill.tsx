import type { JSX } from 'react';
import './StatusPill.css';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface StatusPillProps {
  label: string;
  tone?: StatusTone;
  /** Hides the leading dot for label-only usage. */
  dot?: boolean;
}

export function StatusPill({ label, tone = 'neutral', dot = true }: StatusPillProps): JSX.Element {
  return (
    <span className="status-pill" data-tone={tone}>
      {dot && <span className="status-pill__dot" aria-hidden="true" />}
      {label}
    </span>
  );
}

/** Maps the words we use across the app to a tone, so colour stays consistent. */
export function toneForStatus(status: string): StatusTone {
  switch (status.toLowerCase()) {
    case 'running':
    case 'active':
    case 'success':
    case 'healthy':
      return 'success';
    case 'building':
    case 'deploying':
    case 'queued':
    case 'pending':
      return 'warning';
    case 'failed':
    case 'error':
    case 'stopped':
      return 'danger';
    case 'idle':
      return 'neutral';
    default:
      return 'info';
  }
}
