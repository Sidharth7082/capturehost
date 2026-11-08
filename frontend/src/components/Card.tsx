import type { JSX, ReactNode } from 'react';
import './Card.css';

export interface CardProps {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Removes body padding — for tables that should reach the card edge. */
  flush?: boolean;
  raised?: boolean;
  className?: string;
  id?: string;
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  flush = false,
  raised = false,
  className = '',
  id,
}: CardProps): JSX.Element {
  return (
    <section id={id} className={`card ${raised ? 'card--raised' : ''} ${className}`.trim()}>
      {(title || actions) && (
        <header className="card__header">
          <div className="card__heading">
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className={`card__body ${flush ? 'card__body--flush' : ''}`.trim()}>{children}</div>
    </section>
  );
}
