import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/connection.js';
import { insertNotification, lastNotificationAt, markRead, unreadCount } from '../db/ops.repo.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';

/**
 * Notifications: an in-app feed plus one optional outbound webhook.
 *
 * Two rules keep this from becoming a spam cannon or an SSRF gadget:
 *  1. every event carries a dedupe key with a cooldown, so a container that
 *     restarts in a loop produces one notification per window, not per restart;
 *  2. the outbound URL is https-only, its hostname must resolve to a public
 *     address (never loopback/private/link-local), redirects are not followed
 *     and the timeout is short. Message bodies carry no secrets.
 */

export type Severity = 'info' | 'warning' | 'error';

export interface NotifyInput {
  event: string;
  title: string;
  body?: string;
  severity?: Severity;
  /** Cooldown bucket, e.g. "deploy.failed:3". Omit for once-per-event. */
  dedupeKey?: string;
  meta?: Record<string, unknown>;
}

export interface NotifyResult {
  stored: boolean;
  delivered: boolean;
  reason?: string;
  id?: number;
}

const PRIVATE_V4 = [
  { cidr: [10, 0, 0, 0], bits: 8 },
  { cidr: [172, 16, 0, 0], bits: 12 },
  { cidr: [192, 168, 0, 0], bits: 16 },
  { cidr: [127, 0, 0, 0], bits: 8 },
  { cidr: [169, 254, 0, 0], bits: 16 },
  { cidr: [100, 64, 0, 0], bits: 10 },
  { cidr: [0, 0, 0, 0], bits: 8 },
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return PRIVATE_V4.some(({ cidr, bits }) => {
    const base = ipv4ToInt(cidr.join('.'));
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // fc00::/7 (unique local), fe80::/10 (link local), and IPv4-mapped forms.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true; // not an address at all: treat as unsafe
}

/**
 * Validates an outbound webhook URL, resolving DNS too.
 * Exported so the tests can attack it directly.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.badRequest('Notification URL is not a valid URL', 'bad_notify_url');
  }

  if (url.protocol !== 'https:') {
    throw AppError.badRequest('Notification URL must use https', 'notify_requires_https');
  }

  if (url.username !== '' || url.password !== '') {
    throw AppError.badRequest('Notification URL must not embed credentials', 'notify_has_credentials');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw AppError.badRequest('Notification URL points at a private or loopback address', 'notify_private_address');
    }
    return url;
  }

  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(hostname)) {
    throw AppError.badRequest('Notification URL points at a private hostname', 'notify_private_address');
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw AppError.badRequest('Notification hostname does not resolve', 'notify_unresolvable');
  }

  if (addresses.length === 0) {
    throw AppError.badRequest('Notification hostname does not resolve', 'notify_unresolvable');
  }

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw AppError.badRequest(
        'Notification hostname resolves to a private or loopback address',
        'notify_private_address',
      );
    }
  }

  return url;
}

export class NotificationService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;

  constructor(deps: { db: Db; config: AppConfig; logger: Logger }) {
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger;
  }

  /**
   * Records a notification unless its dedupe key fired inside the cooldown.
   * Returns what happened so callers (and tests) can assert on it.
   */
  async notify(input: NotifyInput): Promise<NotifyResult> {
    const now = Date.now();
    const dedupeKey = input.dedupeKey ?? input.event;

    const previous = lastNotificationAt(this.db, dedupeKey);
    if (previous !== null && now - previous < this.config.notify.cooldownMs) {
      return { stored: false, delivered: false, reason: 'cooldown' };
    }

    const id = insertNotification(this.db, {
      event: input.event,
      severity: input.severity ?? 'info',
      title: input.title,
      body: input.body ?? null,
      dedupeKey,
      meta: input.meta ? JSON.stringify(input.meta) : null,
      now,
    });

    const delivered = await this.deliver({
      event: input.event,
      severity: input.severity ?? 'info',
      title: input.title,
      body: input.body ?? null,
      at: new Date(now).toISOString(),
    });

    return { stored: true, delivered, id };
  }

  /** Sends a test message to the configured channel (no storage side effect). */
  async sendTest(): Promise<{ ok: boolean; error: string | null }> {
    if (!this.config.notify.webhookUrl) {
      return { ok: false, error: 'No NOTIFY_WEBHOOK_URL configured' };
    }

    try {
      await this.post(this.config.notify.webhookUrl, {
        event: 'test',
        severity: 'info',
        title: 'CaptureHost test notification',
        body: 'If you can read this, the channel works.',
        at: new Date().toISOString(),
      });
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'delivery failed' };
    }
  }

  unread(): number {
    return unreadCount(this.db);
  }

  markRead(ids: number[] | 'all'): number {
    return markRead(this.db, ids, Date.now());
  }

  /** Channel status for the settings screen — never the secret URL itself. */
  channelStatus(): { configured: boolean; host: string | null } {
    const url = this.config.notify.webhookUrl;
    if (!url) return { configured: false, host: null };

    try {
      const parsed = new URL(url);
      // Host only: the path is often the secret (ntfy topic, Discord token).
      return { configured: true, host: parsed.hostname };
    } catch {
      return { configured: true, host: null };
    }
  }

  // ----------------------------------------------------------------- private

  private async deliver(payload: Record<string, unknown>): Promise<boolean> {
    if (!this.config.notify.webhookUrl) return false;

    try {
      await this.post(this.config.notify.webhookUrl, payload);
      return true;
    } catch (error) {
      this.logger.warn({ err: error }, 'notification webhook failed');
      return false;
    }
  }

  private async post(rawUrl: string, payload: Record<string, unknown>): Promise<void> {
    const url = await assertSafeWebhookUrl(rawUrl);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'CaptureHost/1' },
      body: JSON.stringify({ source: 'capturehost', ...payload }),
      redirect: 'manual', // a redirect could point at an internal address
      signal: AbortSignal.timeout(this.config.notify.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Webhook answered ${response.status}`);
    }
  }
}
