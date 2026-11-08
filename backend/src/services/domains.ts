import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { AppError } from '../utils/errors.js';

/**
 * Domain policy: hostnames, upstreams and the shape of a Caddy route.
 *
 * Two rules matter more than the rest:
 *  1. a hostname may only be attached inside an operator-approved base domain,
 *     and never for a name we reserve (the dashboard, the webhook gateway);
 *  2. an upstream may only ever be 127.0.0.1:<app port> for the project's own
 *     live container. 2375 (Docker proxy), 2019 (Caddy admin), 8787 (backend)
 *     and the dashboard listener are refused by name as well as by range, so a
 *     future refactor cannot quietly expose them.
 */

export interface HostnamePolicy {
  allowedBaseDomains: readonly string[];
  /** Hosts this app already uses for itself. */
  reservedHosts: readonly string[];
}

export interface HostnameCheck {
  ok: boolean;
  hostname: string;
  reason?: string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Trim + lowercase only. Validation is separate so errors can be specific. */
export function normaliseHostname(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateHostname(raw: string, policy: HostnamePolicy): HostnameCheck {
  const hostname = normaliseHostname(raw);

  if (hostname === '') return { ok: false, hostname, reason: 'Hostname is empty' };
  if (hostname.length > 253) return { ok: false, hostname, reason: 'Hostname is longer than 253 characters' };
  if (hostname.endsWith('.')) return { ok: false, hostname, reason: 'Hostname must not end with a dot' };
  if (hostname.includes('*')) return { ok: false, hostname, reason: 'Wildcards are not allowed' };
  if (hostname.includes('_')) return { ok: false, hostname, reason: 'Underscores are not allowed' };
  if (hostname.includes('/') || hostname.includes(':') || hostname.includes(' ')) {
    return { ok: false, hostname, reason: 'Hostname must be a bare name, without scheme, port or path' };
  }
  if (IPV4.test(hostname) || hostname.includes(':')) {
    return { ok: false, hostname, reason: 'IP addresses are not allowed' };
  }

  const labels = hostname.split('.');
  if (labels.length < 2) return { ok: false, hostname, reason: 'Hostname needs at least two labels' };

  for (const label of labels) {
    if (label.length === 0) return { ok: false, hostname, reason: 'Hostname has an empty label' };
    if (label.length > 63) return { ok: false, hostname, reason: `Label "${label}" is longer than 63 characters` };
    if (!LABEL.test(label)) {
      return {
        ok: false,
        hostname,
        reason: 'Use lowercase letters, digits and dashes only (a dash cannot start or end a label)',
      };
    }
  }

  const base = policy.allowedBaseDomains.find((domain) => hostname.endsWith(`.${domain}`));
  if (!base) {
    return {
      ok: false,
      hostname,
      reason: `Hostname must end with ${policy.allowedBaseDomains.map((domain) => `.${domain}`).join(' or ')}`,
    };
  }

  for (const reserved of policy.reservedHosts) {
    if (hostname === reserved) {
      return { ok: false, hostname, reason: `"${reserved}" is reserved by CaptureHost` };
    }
  }

  return { ok: true, hostname };
}

// --------------------------------------------------------------- upstreams

export interface UpstreamPolicy {
  portRangeStart: number;
  portRangeEnd: number;
  /** Ports that must never be reachable through the apps listener. */
  forbiddenPorts: readonly number[];
}

/** The single place that decides whether a port may be proxied. */
export function assertAllowedUpstream(port: number, policy: UpstreamPolicy): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw AppError.badRequest('Upstream port is invalid', 'bad_upstream');
  }

  if (policy.forbiddenPorts.includes(port)) {
    throw AppError.badRequest(
      `Port ${port} belongs to CaptureHost itself and can never be published`,
      'forbidden_upstream',
    );
  }

  if (port < policy.portRangeStart || port > policy.portRangeEnd) {
    throw AppError.badRequest(
      `Upstream port ${port} is outside the app range ${policy.portRangeStart}-${policy.portRangeEnd}`,
      'upstream_out_of_range',
    );
  }
}

/** True when the port is one the apps listener is allowed to reach. */
export function isAllowedUpstream(port: number, policy: UpstreamPolicy): boolean {
  try {
    assertAllowedUpstream(port, policy);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ routes

export const ROUTE_TAG_PREFIX = 'capturehost-';

/**
 * The 404 catch-all is written by the backend, not the Caddyfile.
 *
 * Caddy can only append to a server's route list, so a catch-all route loaded
 * from the file would sit at index 0 and shadow every route added later. Owning
 * it here keeps the order right after every sync: routes first, catch-all last.
 */
export const CATCH_ALL_TAG = `${ROUTE_TAG_PREFIX}catchall`;

export function buildCatchAllRoute(): Record<string, unknown> {
  return { '@id': CATCH_ALL_TAG, handle: [{ handler: 'static_response', status_code: 404 }] };
}

export function routeTag(domainId: number): string {
  return `${ROUTE_TAG_PREFIX}${domainId}`;
}

export function isManagedRoute(route: unknown): boolean {
  const tag = (route as { '@id'?: unknown })['@id'];
  return typeof tag === 'string' && tag.startsWith(ROUTE_TAG_PREFIX);
}

/**
 * The route object written into the apps server.
 *
 * A host matcher (so one listener serves every project), a reverse_proxy to the
 * loopback port, `terminal: true` so nothing later in the list can shadow it,
 * and an @id so the route can be found and replaced later without touching
 * anything the backend did not create.
 */
export function buildAppRoute(
  domain: { id: number; hostname: string },
  upstreamPort: number,
  policy: UpstreamPolicy,
): Record<string, unknown> {
  assertAllowedUpstream(upstreamPort, policy);

  return {
    '@id': routeTag(domain.id),
    match: [{ host: [domain.hostname] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: `127.0.0.1:${upstreamPort}` }],
        headers: { request: { set: { 'X-Forwarded-Host': ['{http.request.host}'] } } },
      },
    ],
    terminal: true,
  };
}

/**
 * Recursively sorts object keys so that a config parsed by Go (which marshals
 * maps in sorted order) and the one built here compare equal. Comparing raw
 * JSON strings was the bug that made every sync look like drift.
 */
export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalise(entry));

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(source).sort()) sorted[key] = canonicalise(source[key]);
    return sorted;
  }

  return value;
}

/**
 * What "the same route" means.
 *
 * Everything that changes behaviour is included — the tag, the host matchers,
 * the proxy handler and its upstream, the headers we set, and whether the route
 * is terminal — and nothing else. Key order and formatting are irrelevant, so a
 * round-tripped route never counts as drift.
 */
export function routeFingerprint(route: Record<string, unknown>): string {
  const handle = Array.isArray(route.handle) ? (route.handle as Record<string, unknown>[]) : [];
  const proxy = handle[0] ?? {};
  const upstreams = Array.isArray(proxy.upstreams) ? (proxy.upstreams as { dial?: string }[]) : [];
  const matchers = Array.isArray(route.match) ? (route.match as Record<string, unknown>[]) : [];

  return JSON.stringify(
    canonicalise({
      id: route['@id'] ?? null,
      hosts: (matchers[0]?.host as string[] | undefined) ?? [],
      handlers: handle.map((entry) => entry.handler ?? null),
      dial: upstreams[0]?.dial ?? null,
      // The headers we attach are configuration too: if one changes and the
      // fingerprint ignored it, real drift would go unnoticed.
      headers: proxy.headers ?? null,
      terminal: route.terminal === true,
    }),
  );
}

/** Extracts the port a managed route points at, for drift detection. */
export function upstreamPortOf(route: unknown): number | null {
  const handlers = (route as { handle?: unknown[] }).handle;
  if (!Array.isArray(handlers)) return null;

  for (const handler of handlers) {
    const upstreams = (handler as { upstreams?: { dial?: string }[] }).upstreams;
    if (!Array.isArray(upstreams) || upstreams.length === 0) continue;

    const dial = upstreams[0]?.dial ?? '';
    const match = /^127\.0\.0\.1:(\d+)$/.exec(dial);
    if (match?.[1]) return Number(match[1]);
  }

  return null;
}

// ------------------------------------------------------------------ probes

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  httpsOk: boolean | null;
  error: string | null;
}

export interface ProbeOptions {
  listen: { host: string; port: number };
  timeoutMs?: number;
  useTls?: boolean;
  path?: string;
}

/**
 * Requests a hostname through the apps listener.
 *
 * The Host header is set by hand, which is the whole point: this is exactly
 * what a browser asks for once DNS (or *.localhost) resolves, and it proves the
 * route exists rather than only that the container is up.
 */
export function probeHostname(hostname: string, options: ProbeOptions): Promise<ProbeResult> {
  const { listen, timeoutMs = 5000, useTls = false, path = '/' } = options;
  const started = Date.now();

  return new Promise<ProbeResult>((resolve) => {
    const request = (useTls ? httpsRequest : httpRequest)(
      {
        host: listen.host,
        port: listen.port,
        path,
        method: 'GET',
        timeout: timeoutMs,
        headers: { Host: hostname, 'User-Agent': 'CaptureHost-HealthCheck/1.0', Accept: '*/*' },
        ...(useTls ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const latencyMs = Date.now() - started;
        // Drain so the socket can be reused/closed cleanly.
        response.resume();
        response.on('end', () => {
          const status = response.statusCode ?? null;
          resolve({
            ok: status !== null && status >= 200 && status < 400,
            status,
            latencyMs,
            httpsOk: useTls ? true : null,
            error: status !== null && status >= 400 ? `HTTP ${status}` : null,
          });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('timed out'));
    });

    request.on('error', (error: Error) => {
      resolve({
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        httpsOk: useTls ? false : null,
        error: error.message,
      });
    });

    request.end();
  });
}
