import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import './Dropdown.css';

export interface DropdownItem {
  key: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  dividerBefore?: boolean;
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

function isIconName(value: unknown): value is IconName {
  return typeof value === 'string';
}

/**
 * Menu button. Closes on outside click, Escape, or selection; roving focus is
 * handled by the browser because items are real buttons.
 */
export function Dropdown({
  items,
  trigger,
  triggerLabel,
  triggerClassName = 'icon-button',
  align = 'right',
}: DropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={wrapperRef}>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {isIconName(trigger) ? <Icon name={trigger} /> : trigger}
      </button>

      {open && (
        <div className="dropdown__menu" role="menu" data-align={align}>
          {items.map((item) => (
            <div key={item.key}>
              {item.dividerBefore && <div className="dropdown__divider" role="separator" />}
              <button
                type="button"
                role="menuitem"
                className="dropdown__item"
                data-danger={item.danger ? 'true' : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon && <Icon name={item.icon} />}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
