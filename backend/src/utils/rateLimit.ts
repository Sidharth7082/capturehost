/**
 * In-memory sliding-window rate limiter for *actions* (start/stop/restart/remove).
 *
 * Deliberately not in SQLite, unlike the login throttle: this protects against
 * a stuck loop or a double-click storm, not against an attacker who controls
 * the session. Losing the counters on restart is fine and keeps the hot path
 * free of disk writes.
 */
export class SessionRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Records one attempt and reports whether it is allowed. */
  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number; remaining: number } {
    const cutoff = now - this.windowMs;
    const existing = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

    if (existing.length >= this.limit) {
      const oldest = existing[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.hits.set(key, existing);
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }

    existing.push(now);
    this.hits.set(key, existing);

    // Opportunistic cleanup so a long-running process does not leak keys.
    if (this.hits.size > 500) this.prune(now);

    return { allowed: true, retryAfterSeconds: 0, remaining: this.limit - existing.length };
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const fresh = timestamps.filter((timestamp) => timestamp > cutoff);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}
