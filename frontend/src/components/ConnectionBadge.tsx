import type { JSX } from 'react';
import type { ConnectionStatus } from '../hooks/useMetricsSocket';
import './ConnectionBadge.css';

const LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

export interface ConnectionBadgeProps {
  status: ConnectionStatus;
  attempts?: number;
}

/**
 * "Live / Reconnecting" indicator. `role="status"` + aria-live means screen
 * readers hear the change without the visual pulse being the only signal.
 */
export function ConnectionBadge({ status, attempts = 0 }: ConnectionBadgeProps): JSX.Element {
  const label = status === 'reconnecting' && attempts > 1 ? `Reconnecting (${attempts})` : LABELS[status];

  return (
    <span className="connection-badge" data-state={status} role="status" aria-live="polite">
      <span className="connection-badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
