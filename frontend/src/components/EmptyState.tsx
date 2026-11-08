import type { JSX, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import './EmptyState.css';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Red styling for failures, neutral otherwise. */
  variant?: 'default' | 'error';
}

export function EmptyState({
  icon = 'projects',
  title,
  description,
  action,
  variant = 'default',
}: EmptyStateProps): JSX.Element {
  return (
    <div className={`empty-state ${variant === 'error' ? 'empty-state--error' : ''}`.trim()} role={variant === 'error' ? 'alert' : undefined}>
      <span className="empty-state__icon">
        <Icon name={variant === 'error' ? 'alert' : icon} size={18} />
      </span>
      <p className="empty-state__title">{title}</p>
      {description && <p className="empty-state__description">{description}</p>}
      {action}
    </div>
  );
}
