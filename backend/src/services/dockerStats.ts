import type { Logger } from '../logger.js';
import type { ContainerStatsSample, DockerService } from './docker.js';

export interface DockerStatsPayload {
  ts: number;
  available: boolean;
  error: string | null;
  containers: ContainerStatsSample[];
}

export interface DockerStatsPollerDeps {
  docker: DockerService;
  intervalMs: number;
  logger: Logger;
}

/**
 * One shared poller for `/ws/docker/stats`, exactly like the metrics sampler.
 *
 * Ten open dashboards must cost one listContainers + N stats calls per tick,
 * not ten times that. Docker's stats endpoint is expensive (it blocks for a
 * sample interval), so this also avoids hammering the daemon.
 *
 * Polling stops when the last subscriber leaves: an idle dashboard should not
 * keep the daemon busy.
 */
export class DockerStatsPoller {
  private readonly docker: DockerService;
  private readonly intervalMs: number;
  private readonly logger: Logger;

  private readonly subscribers = new Set<(payload: DockerStatsPayload) => void>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private last: DockerStatsPayload | null = null;

  constructor(deps: DockerStatsPollerDeps) {
    this.docker = deps.docker;
    this.intervalMs = deps.intervalMs;
    this.logger = deps.logger;
  }

  getLast(): DockerStatsPayload | null {
    return this.last;
  }

  subscribe(callback: (payload: DockerStatsPayload) => void): () => void {
    this.subscribers.add(callback);

    if (this.timer === null) {
      // First subscriber: emit what we have immediately, then start polling.
      if (this.last) callback(this.last);
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref?.();
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subscribers.clear();
  }

  private async tick(): Promise<void> {
    // Never overlap: a slow docker call must not queue up behind itself.
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const containers = await this.docker.list();
      const runningIds = containers.filter((container) => container.state === 'running').map((c) => c.id);
      const stats = await this.docker.statsFor(runningIds);

      const payload: DockerStatsPayload = {
        ts: Date.now(),
        available: true,
        error: null,
        containers: [...stats.values()],
      };

      this.publish(payload);
    } catch (error) {
      // The dashboard keeps working: it just shows "Docker unavailable".
      const payload: DockerStatsPayload = {
        ts: Date.now(),
        available: false,
        error: 'Docker unavailable',
        containers: [],
      };
      this.publish(payload);
      this.logger.debug({ err: error }, 'docker stats poll failed');
    } finally {
      this.inFlight = false;
    }
  }

  private publish(payload: DockerStatsPayload): void {
    this.last = payload;
    for (const callback of this.subscribers) {
      try {
        callback(payload);
      } catch {
        // A dead socket must not stop the poller for everyone else.
      }
    }
  }
}
