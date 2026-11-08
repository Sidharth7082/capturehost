import { useRef, type JSX, type KeyboardEvent } from 'react';
import './Tabs.css';

export interface TabItem<T extends string> {
  value: T;
  label: string;
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the tab list. */
  label: string;
}

/**
 * Small segmented control with proper tab semantics and arrow-key navigation
 * (left/right move the selection, which is what users expect in a tablist).
 */
export function Tabs<T extends string>({ items, value, onChange, label }: TabsProps<T>): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = items.findIndex((item) => item.value === value);
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;

    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = items[(index + delta + items.length) % items.length];
    if (!next) return;

    onChange(next.value);
    const button = listRef.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`);
    button?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          className="tabs__tab"
          data-value={item.value}
          aria-selected={item.value === value}
          tabIndex={item.value === value ? 0 : -1}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
