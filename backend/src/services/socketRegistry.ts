/**
 * Tracks the live WebSockets so a logout can actually close them.
 *
 * Without this, "log out" would only clear the cookie: any already-open socket
 * would keep streaming machine metrics until the tab was reloaded, which is
 * exactly the window an attacker with a stolen session wants.
 */

export interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

export class SocketRegistry {
  private readonly bySession = new Map<string, Set<ClosableSocket>>();

  add(sessionId: string, socket: ClosableSocket): void {
    const set = this.bySession.get(sessionId) ?? new Set<ClosableSocket>();
    set.add(socket);
    this.bySession.set(sessionId, set);
  }

  remove(sessionId: string, socket: ClosableSocket): void {
    const set = this.bySession.get(sessionId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.bySession.delete(sessionId);
  }

  /** Closes every socket belonging to one session (logout, revoke, expiry). */
  closeSession(sessionId: string, reason = 'session ended'): number {
    const set = this.bySession.get(sessionId);
    if (!set) return 0;

    let closed = 0;
    for (const socket of set) {
      try {
        // 1008 = policy violation: the client should not treat this as a
        // transient network error and auto-reconnect.
        socket.close(1008, reason);
        closed += 1;
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.bySession.delete(sessionId);
    return closed;
  }

  closeSessions(sessionIds: readonly string[], reason = 'session ended'): number {
    return sessionIds.reduce((total, id) => total + this.closeSession(id, reason), 0);
  }

  size(): number {
    let total = 0;
    for (const set of this.bySession.values()) total += set.size;
    return total;
  }
}
