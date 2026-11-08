import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { NAV_PAGES } from '../navigation';
import './CommandPalette.css';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Quick page jumper (Ctrl/Cmd+K).
 *
 * Arrow keys move the highlight, Enter runs the highlighted command, Escape
 * closes. Unbuilt pages stay listed but cannot be selected, so the palette
 * doubles as a roadmap.
 */
export function CommandPalette({ open, onClose }: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return NAV_PAGES;
    return NAV_PAGES.filter(
      (page) =>
        page.label.toLowerCase().includes(needle) || page.subtitle.toLowerCase().includes(needle),
    );
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    // Focus after paint so the input exists.
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const select = (index: number): void => {
    const page = results[index];
    if (!page || !page.ready) return;
    navigate(page.path);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      select(activeIndex);
    }
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette__search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page…"
            aria-label="Search pages"
            aria-controls="palette-results"
          />
        </div>

        <div className="palette__list" id="palette-results" role="listbox" aria-label="Pages">
          {results.length === 0 ? (
            <p className="palette__empty">No page matches “{query}”.</p>
          ) : (
            results.map((page, index) => (
              <button
                key={page.path}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className="palette__item"
                data-active={index === activeIndex ? 'true' : 'false'}
                disabled={!page.ready}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(index)}
              >
                <Icon name={page.icon} size={16} />
                {page.label}
                {!page.ready && <span className="palette__hint">Phase {page.phase}</span>}
              </button>
            ))
          )}
        </div>

        <div className="palette__footer">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
