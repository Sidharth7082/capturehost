import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import './Drawer.css';

export interface DrawerProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
  /** Removes body padding — used by the log viewer, which scrolls itself. */
  flush?: boolean;
  wide?: boolean;
}

/**
 * Right-hand slide-over panel.
 *
 * Same contract as Modal: portal (nothing can clip it), Escape closes, focus
 * moves in and returns to the trigger, body scroll locked while open.
 */
export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  actions,
  children,
  flush = false,
  wide = false,
}: DrawerProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Same reason as Modal: an inline onClose would re-run this effect on every
  // render and yank focus out of any input in the drawer.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current();
    };

    document.addEventListener('keydown', onKeyDown);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    panelRef.current
      ?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="drawer-scrim" onMouseDown={onClose} aria-hidden="true" />
      <aside
        className={`drawer ${wide ? 'drawer--wide' : ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
      >
        <header className="drawer__header">
          <div className="drawer__titles">
            <h2 className="drawer__title">{title}</h2>
            {subtitle && <p className="drawer__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="drawer__actions">{actions}</div>}
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
            <Icon name="close" />
          </button>
        </header>
        <div className={`drawer__body ${flush ? 'drawer__body--flush' : ''}`.trim()}>{children}</div>
      </aside>
    </>,
    document.body,
  );
}
