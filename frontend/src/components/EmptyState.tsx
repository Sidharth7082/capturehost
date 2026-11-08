import type { JSX, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import './EmptyState.css';

export interface EmptyStateIllustration {
  /** Imported asset URL (Vite gives these a hashed name). */
  src: string;
  /** Intrinsic size, so the box is reserved before the image decodes. */
  width?: number;
  height?: number;
}

export interface EmptyStateProps {
  icon?: IconName;
  /**
   * Big picture for page-level empty states. Decorative by definition — the title
   * and description carry the meaning, so it is hidden from the accessibility tree
   * rather than announced twice.
   */
  illustration?: EmptyStateIllustration;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Red styling for failures, neutral otherwise. */
  variant?: 'default' | 'error';
}

export function EmptyState({
  icon = 'projects',
  illustration,
  title,
  description,
  action,
  variant = 'default',
}: EmptyStateProps): JSX.Element {
  const classes = [
    'empty-state',
    variant === 'error' ? 'empty-state--error' : '',
    illustration ? 'empty-state--illustrated' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} role={variant === 'error' ? 'alert' : undefined}>
      {illustration ? (
        <img
          className="empty-state__illustration"
          src={illustration.src}
          // Decorative: the heading under it says what the picture implies.
          alt=""
          aria-hidden="true"
          width={illustration.width ?? 480}
          height={illustration.height ?? 350}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="empty-state__icon">
          <Icon name={variant === 'error' ? 'alert' : icon} size={18} />
        </span>
      )}
      <p className="empty-state__title">{title}</p>
      {description && <p className="empty-state__description">{description}</p>}
      {action}
    </div>
  );
}
