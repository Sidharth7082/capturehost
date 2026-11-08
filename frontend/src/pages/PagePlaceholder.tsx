import type { JSX, ReactNode } from 'react';
import { StatusPill } from '../components/StatusPill';
import './Placeholder.css';

export interface PagePlaceholderProps {
  /** The phase that will build this page. */
  phase: number;
  title: string;
  description: string;
  toolbar?: ReactNode;
  children: ReactNode;
}

/**
 * Consistent "not built yet" frame for pages that arrive in later phases.
 *
 * The scaffold around it is real (toolbar, table, empty state) so the future
 * page has somewhere to drop its data — and so the layout is already proven at
 * 360px before there is anything to break.
 */
export function PagePlaceholder({
  phase,
  title,
  description,
  toolbar,
  children,
}: PagePlaceholderProps): JSX.Element {
  return (
    <div className="page-placeholder">
      <div className="page-placeholder__banner" role="note">
        <div className="page-placeholder__banner-text">
          <span className="page-placeholder__banner-title">{title}</span>
          <span className="page-placeholder__banner-sub">{description}</span>
        </div>
        <StatusPill label={`Phase ${phase}`} tone="info" dot={false} />
      </div>

      {toolbar}
      {children}

      <p className="page-placeholder__banner-sub">
        The layout and empty states are final; the data wiring lands in Phase {phase}.
      </p>
    </div>
  );
}
