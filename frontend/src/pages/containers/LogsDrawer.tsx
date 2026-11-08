import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ContainerSummary } from '../../api/client';
import { Button } from '../../components/Button';
import { ConnectionBadge } from '../../components/ConnectionBadge';
import { Drawer } from '../../components/Drawer';
import { Icon } from '../../components/Icon';
import { useContainerLogs } from '../../hooks/useContainerLogs';
import { useToast } from '../../components/Toast';

export interface LogsDrawerProps {
  container: ContainerSummary | null;
  onClose: () => void;
}

const TAIL_OPTIONS = [200, 500, 2000] as const;

/**
 * Live log viewer.
 *
 * Follows by default (auto-scroll to the newest line). Scrolling up pauses the
 * auto-scroll but keeps receiving; the explicit Pause button stops rendering
 * new lines entirely and buffers them, which is what you want when a container
 * is spewing.
 */
export function LogsDrawer({ container, onClose }: LogsDrawerProps): JSX.Element {
  const [tail, setTail] = useState<number>(200);
  const [query, setQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const { lines, connected, ended, error, dropped, paused, togglePause, clear } = useContainerLogs(
    container?.id ?? null,
    tail,
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return lines;
    return lines.filter((line) => line.text.toLowerCase().includes(needle));
  }, [lines, query]);

  useEffect(() => {
    if (!autoScroll || paused) return;
    const element = bodyRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [visible.length, autoScroll, paused]);

  const onScroll = (): void => {
    const element = bodyRef.current;
    if (!element) return;

    // Within 40px of the bottom counts as "following".
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const copyAll = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(visible.map((line) => line.text).join('\n'));
      toast.push('Copied', { message: `${visible.length} lines`, tone: 'success' });
    } catch {
      toast.push('Could not copy', { message: 'Clipboard permission denied', tone: 'danger' });
    }
  };

  return (
    <Drawer
      open={container !== null}
      onClose={onClose}
      wide
      flush
      title={container ? `Logs — ${container.name}` : 'Logs'}
      subtitle={container?.image}
      actions={
        <>
          <ConnectionBadge status={ended ? 'offline' : connected ? 'live' : 'reconnecting'} />
          <Button size="sm" icon={<Icon name={paused ? 'check' : 'clock'} size={14} />} onClick={togglePause}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" icon={<Icon name="logs" size={14} />} onClick={() => void copyAll()}>
            Copy
          </Button>
          <Button size="sm" onClick={clear}>
            Clear
          </Button>
        </>
      }
    >
      <div className="logs-toolbar">
        <label className="page-toolbar__search">
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder="Search loaded lines…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search log lines"
          />
        </label>

        <div className="logs-toolbar__tails" role="group" aria-label="Tail size">
          {TAIL_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className="logs-tail"
              data-active={tail === option ? 'true' : 'false'}
              onClick={() => setTail(option)}
            >
              {option}
            </button>
          ))}
        </div>

        <span className="logs-toolbar__meta">
          {visible.length}
          {query ? ` / ${lines.length}` : ''} lines
          {paused && ' · paused'}
          {dropped > 0 && ` · ${dropped} dropped`}
        </span>
      </div>

      {error && (
        <p className="logs-banner" role="alert">
          <Icon name="alert" size={14} /> {error}
        </p>
      )}

      {ended && (
        <p className="logs-banner">
          <Icon name="info" size={14} /> Stream ended — the container stopped or the log was rotated.
        </p>
      )}

      <div className="logs-body" ref={bodyRef} onScroll={onScroll} tabIndex={0} aria-label="Container logs">
        {visible.length === 0 ? (
          <p className="logs-empty">
            {query ? `No line matches “${query}”.` : 'Waiting for log output…'}
          </p>
        ) : (
          visible.map((line) => (
            <div className="logs-line" key={line.n}>
              {line.text}
            </div>
          ))
        )}
      </div>

      {!autoScroll && (
        <button
          type="button"
          className="logs-jump"
          onClick={() => {
            setAutoScroll(true);
            const element = bodyRef.current;
            if (element) element.scrollTop = element.scrollHeight;
          }}
        >
          <Icon name="chevron-down" size={14} /> Jump to latest
        </button>
      )}
    </Drawer>
  );
}
