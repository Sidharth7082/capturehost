import { normaliseOrigin } from '../config.js';

/**
 * WebSocket handshakes are NOT protected by the same-origin policy: any page
 * the admin visits could otherwise open a socket to 127.0.0.1:8787 and stream
 * their machine metrics. Browsers always send `Origin` on a WS upgrade, so
 * checking it is the effective defence.
 *
 * Absent Origin is rejected too — non-browser clients must opt in explicitly,
 * which keeps the rule simple and auditable.
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return false;
  const normalised = normaliseOrigin(origin);
  return allowedOrigins.some((allowed) => normaliseOrigin(allowed) === normalised);
}
