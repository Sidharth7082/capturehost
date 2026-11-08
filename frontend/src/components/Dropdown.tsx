import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import './Dropdown.css';

export interface DropdownItem {
  key: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  dividerBefore?: boolean;
  /** Rendered but not selectable — e.g. Stop on a stopped container. */
  disabled?: boolean;
  onSelect: () => void;
}

export interface DropdownProps {
  items: readonly DropdownItem[];
  /** Button content: an icon name, or arbitrary nodes (e.g. an avatar). */
  trigger: IconName | ReactNode;
  triggerLabel: string;
  triggerClassName?: string;
  align?: 'left' | 'right';
}

/** Space between the trigger and the menu. */
const GAP = 6;
/** Never closer than this to the viewport edge. */
const MARGIN = 8;

interface MenuPosition {
  top: number;
  left: number;
  /** Which side of the trigger the menu ended up on. */
  side: 'top' | 'bottom';
}

function isIconName(value: unknown): value is IconName {
  return typeof value === 'string';
}

/**
 * Menu button rendered in a portal with viewport coordinates.
 *
 * Why not absolute positioning inside the wrapper: every row menu lives in a
 * table wrapped in `overflow-x: auto`, which is a clipping box for absolutely
 * positioned children. The menu was cut off at the table edge, gave the table
 * its own scrollbar, and scrolled the row out of view. `position: fixed` inside
 * a portal escapes every ancestor's overflow and stacking context; the price is
 * that the position must be recomputed from the trigger's rect, which is what
 * `place()` does — flip up when there is no room below, clamp to the viewport.
 *
 * Closes on outside pointerdown, Escape (focus back to the trigger), selection,
 * scroll and resize: after a scroll the measured coordinates are stale, so
 * closing beats drifting.
 */
export function Dropdown({
  items,
  trigger,
  triggerLabel,
  triggerClassName = 'icon-button',
  align = 'right',
}: DropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus = false): void => {
    setOpen(false);
    setPosition(null);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const place = useCallback((): void => {
    const triggerEl = triggerRef.current;
    const menuEl = menuRef.current;
    if (!triggerEl || !menuEl) return;

    const anchor = triggerEl.getBoundingClientRect();
    const menu = menuEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const roomBelow = vh - anchor.bottom;
    const roomAbove = anchor.top;
    // Flip only when below is genuinely too tight *and* above is better: on a
    // short table both are tight and staying below is the lesser evil.
    const flipUp = roomBelow < menu.height + GAP + MARGIN && roomAbove > roomBelow;

    const top = flipUp
      ? Math.max(MARGIN, anchor.top - menu.height - GAP)
      : Math.min(anchor.bottom + GAP, Math.max(MARGIN, vh - menu.height - MARGIN));

    const preferredLeft = align === 'right' ? anchor.right - menu.width : anchor.left;
    const left = Math.min(Math.max(MARGIN, preferredLeft), Math.max(MARGIN, vw - menu.width - MARGIN));

    setPosition({ top, left, side: flipUp ? 'top' : 'bottom' });
  }, [align]);

  // Measure, place, and move focus into the menu in one pass. Focus has to
  // happen here rather than in a passive effect: the menu cannot take focus
  // while it is still invisible, and by the time a `useEffect` runs the browser
  // may already have moved on. `opacity` (not `visibility`) keeps it focusable
  // during the pre-paint layout at the fallback coordinates.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(true);
    };
    const onScroll = (event: Event): void => {
      // Scrolling inside the menu itself must not close it.
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onResize = (): void => close();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    // capture: true catches scrolls from any ancestor scroll container, not just the window.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (buttons.length === 0) return;

    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % buttons.length;
        break;
      case 'ArrowUp':
        next = current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = buttons.length - 1;
        break;
      case 'Tab':
        // Move the focus back to the trigger *before* the default action, so Tab
        // continues from where the user came in instead of from a removed node.
        close(true);
        return;
      default:
        return;
    }

    event.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();

    if (open) {
      // Already open (opened with the mouse, or focus came back): walk in.
      const buttons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
      );
      const target = event.key === 'ArrowDown' ? buttons[0] : buttons[buttons.length - 1];
      target?.focus({ preventScroll: true });
      return;
    }

    setOpen(true);
  };

  return (
    <div className="dropdown">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
      >
        {isIconName(trigger) ? <Icon name={trigger} /> : trigger}
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="dropdown__menu"
            role="menu"
            data-side={position?.side ?? 'bottom'}
            style={{
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
              // Not `visibility: hidden`: an invisible element cannot take focus,
              // and focus lands during the same pre-paint pass that measures it.
              opacity: position ? 1 : 0,
            }}
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item) => (
              <div key={item.key}>
                {item.dividerBefore && <div className="dropdown__divider" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  className="dropdown__item"
                  tabIndex={-1}
                  data-danger={item.danger ? 'true' : undefined}
                  disabled={item.disabled === true}
                  onClick={() => {
                    if (item.disabled) return;
                    close(true);
                    item.onSelect();
                  }}
                >
                  {item.icon && <Icon name={item.icon} />}
                  {item.label}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
