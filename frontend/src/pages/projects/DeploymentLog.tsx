import { useEffect, useRef, useState, type JSX } from 'react';
import { deploymentLogSocketUrl, type Deployment } from '../../api/projects';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';

/**
 * Live build log.
 *
 * One socket per open log, opened with the session cookie (the browser sends it
 * automatically; the server also checks Origin). Lines are appended, the view
 * sticks to the bottom unless the user scrolled up, and pausing only stops
 * rendering — the socket keeps buffering so nothing is lost by pausing.
 */

interface Props {
  deployment: Deployment | null;
}

type Frame = { type: 'open'; payload: { log: string } } | { type: 'line'; payload: { line: string } };

export function DeploymentLog({ deployment }: Props): JSX.Element {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'closed'>('idle');
  const [follow, setFollow] = useState(true);
  const bufferRef = useRef<string[]>([]);
  const viewRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!deployment) return;

    setLines([]);
    bufferRef.current = [];
    setStatus('connecting');

    const socket = new WebSocket(deploymentLogSocketUrl(deployment.id));

    socket.onopen = () => setStatus('open');

    socket.onmessage = (event: MessageEvent<string>) => {
      let frame: Frame;
      try {
        frame = JSON.parse(event.data) as Frame;
      } catch {
        return;
      }

      if (frame.type === 'open') {
        const existing = frame.payload.log.split('\n').filter((line) => line !== '');
        setLines(existing);
        bufferRef.current = existing;
      } else if (frame.type === 'line') {
        bufferRef.current = [...bufferRef.current, frame.payload.line];
        if (!paused) setLines(bufferRef.current);
      }
    };

    socket.onclose = () => {
      setStatus('closed');
    };

    return () => {
      socket.close();
    };
    // `paused` is intentionally not a dependency: the socket must not reconnect
    // when the user pauses, and the handler reads it through the ref-free path
    // above by closing over the current render's value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployment?.id]);

  // Resuming shows everything buffered while paused.
  useEffect(() => {
    if (!paused) setLines(bufferRef.current);
  }, [paused]);

  useEffect(() => {
    if (!follow || !viewRef.current) return;
    viewRef.current.scrollTop = viewRef.current.scrollHeight;
  }, [lines, follow]);

  if (!deployment) {
    return (
      <div className="log-empty">
        <Icon name="logs" size={22} />
        <p>Select a deployment to see its build log.</p>
      </div>
    );
  }

  return (
    <div className="log-viewer">
      <div className="log-viewer__bar">
        <span className={`log-viewer__state log-viewer__state--${status}`}>
          {status === 'open' ? 'live' : status === 'connecting' ? 'connecting…' : status === 'closed' ? 'closed' : 'idle'}
        </span>
        <span className="log-viewer__title">
          Deployment #{deployment.id} · {deployment.shortCommit ?? 'no commit'} · {deployment.status}
        </span>
        <span className="page-toolbar__spacer" />
        <Button variant="ghost" onClick={() => setPaused((value) => !value)}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(lines.join('\n'));
          }}
        >
          Copy
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setFollow((value) => !value);
          }}
        >
          {follow ? 'Unfollow' : 'Follow'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            bufferRef.current = [];
            setLines([]);
          }}
        >
          Clear
        </Button>
      </div>

      {deployment.error ? <div className="log-viewer__error">{deployment.error}</div> : null}

      <pre className="log-viewer__output" ref={viewRef} aria-live="polite">
        {lines.length === 0 ? 'Waiting for output…' : lines.join('\n')}
      </pre>
    </div>
  );
}
