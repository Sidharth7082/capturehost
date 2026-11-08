import { useCallback, useEffect, useState, type JSX } from 'react';
import { ApiError } from '../api/client';
import {
  fetchChannel,
  fetchNotifications,
  markNotificationsRead,
  sendTestNotification,
  type NotificationEntry,
} from '../api/ops';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Skeleton } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { relativeFromNow } from '../utils/format';
import '../styles/ops.css';

/** Notifications: what happened while you were not looking. */

const TONE = { error: 'danger', warning: 'warning', info: 'info' } as const;

export function Notifications(): JSX.Element {
  const toast = useToast();
  const [items, setItems] = useState<NotificationEntry[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [channel, setChannel] = useState<{ configured: boolean; host: string | null; cooldownMinutes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, chan] = await Promise.all([fetchNotifications(100), fetchChannel()]);
      setItems(list.notifications);
      setUnread(list.unread);
      setChannel(chan);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load notifications');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      <div className="page-toolbar">
        <span className="muted">{unread} unread</span>
        <span className="page-toolbar__spacer" />
        <Button
          variant="ghost"
          disabled={unread === 0}
          onClick={() => {
            void markNotificationsRead('all')
              .then(() => {
                toast.push('All notifications marked read', { tone: 'success' });
                void load();
              })
              .catch(() => toast.push('Could not update notifications', { tone: 'danger' }));
          }}
        >
          Mark all read
        </Button>
      </div>

      <Card title="Outbound channel" subtitle="One webhook URL from .env. Secrets are never shown or editable here.">
        <div className="channel-row">
          <StatusPill
            label={channel?.configured ? 'configured' : 'not configured'}
            tone={channel?.configured ? 'success' : 'neutral'}
          />
          <span className="muted">
            {channel?.configured
              ? `POSTs to ${channel.host} · cooldown ${channel.cooldownMinutes} min`
              : 'Set NOTIFY_WEBHOOK_URL (https only) to get alerts outside the dashboard.'}
          </span>
          <span className="page-toolbar__spacer" />
          <Button
            variant="ghost"
            disabled={!channel?.configured}
            onClick={() => {
              void sendTestNotification()
                .then(() => toast.push('Test notification sent', { tone: 'success' }))
                .catch((err: unknown) =>
                  toast.push('Test failed', {
                    message: err instanceof ApiError ? err.message : 'Unknown error',
                    tone: 'danger',
                  }),
                );
            }}
          >
            Send test
          </Button>
        </div>
      </Card>

      {error ? (
        <Card>
          <EmptyState icon="alert" title="Could not load notifications" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
        </Card>
      ) : items === null ? (
        <Card>
          <div className="ops-skeleton">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} height="56px" />
            ))}
          </div>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon="bell"
            title="Nothing to report"
            description="Failed deployments, disk pressure, Caddy trouble and backup failures land here."
          />
        </Card>
      ) : (
        <ul className="notify-list">
          {items.map((item) => (
            <li key={item.id} className={`notify-item${item.readAt ? '' : ' notify-item--unread'}`}>
              <Icon name={item.severity === 'error' ? 'alert' : item.severity === 'warning' ? 'info' : 'check'} size={16} />
              <div className="notify-item__body">
                <div className="notify-item__head">
                  <strong>{item.title}</strong>
                  <StatusPill label={item.severity} tone={TONE[item.severity]} dot={false} />
                  <span className="muted">{relativeFromNow(item.createdAt)}</span>
                </div>
                {item.body ? <p>{item.body}</p> : null}
                <span className="notify-item__event mono">{item.event}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
