import type { ContainerSummary } from './docker.js';
import type { Logger } from '../logger.js';
import type { NotificationService } from './notifications.js';

/**
 * Watches the containers CaptureHost created and reports the two states you
 * cannot see from the dashboard while you are away:
 *   - a restart loop (Docker says "restarting", or the restart count climbs);
 *   - a container that was running and is now exited.
 *
 * Only containers labelled `capturehost.managed=true` are considered, so the
 * proxy, Caddy and anything else on the machine are never reported.
 *
 * Detection is a poll, not an event stream: one `listContainers` call every
 * interval, and an inspect only when a container looks wrong. That keeps it
 * cheap on a laptop and needs no Docker events socket.
 */

/** The two Docker calls this watcher needs, so tests can fake them cheaply. */
export interface WatcherDocker {
  list(): Promise<ContainerSummary[]>;
  containerRuntime(id: string): Promise<{
    state: string;
    exitCode: number;
    restartCount: number;
    labels: Record<string, string>;
  } | null>;
}

export interface ContainerWatcherDeps {
  docker: WatcherDocker;
  notifications: Pick<NotificationService, 'notify'>;
  logger: Logger;
  intervalMs?: number;
}

export type WatcherState = string;

export class ContainerWatcher {
  private readonly docker: ContainerWatcherDeps['docker'];
  private readonly notifications: ContainerWatcherDeps['notifications'];
  private readonly logger: Logger;
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private previous = new Map<string, WatcherState>();
  /** Containers already reported, so one exit is not re-sent every poll. */
  private reported = new Set<string>();

  constructor(deps: ContainerWatcherDeps) {
    this.docker = deps.docker;
    this.notifications = deps.notifications;
    this.logger = deps.logger;
    this.intervalMs = deps.intervalMs ?? 15_000;
  }

  /** One pass. Returns how many alerts it raised (useful in tests). */
  async poll(now = Date.now()): Promise<number> {
    let containers: ContainerSummary[];

    try {
      containers = await this.docker.list();
    } catch (error) {
      // A Docker hiccup is the Caddy/proxy alerts' business, not this one.
      this.logger.debug({ err: error }, 'container watcher: docker unavailable');
      return 0;
    }

    let raised = 0;

    for (const container of containers) {
      if (container.labels['capturehost.managed'] !== 'true') continue;

      const state = container.state;
      const before = this.previous.get(container.id);

      if (state === 'running') {
        this.reported.delete(container.id);
        this.previous.set(container.id, state);
        continue;
      }

      if (state === 'restarting') {
        raised += await this.alertRestartLoop(container, now);
        this.previous.set(container.id, state);
        continue;
      }

      const stopped = state === 'exited' || state === 'dead';

      if (stopped && !this.reported.has(container.id)) {
        // It only counts as "unexpected" if it had been running, or if it
        // failed on the way up (exit code non-zero).
        const runtime = await this.docker.containerRuntime(container.id).catch(() => null);
        const wasRunning = before === 'running';
        const failed = runtime === null || runtime.exitCode !== 0;

        if (wasRunning || failed) {
          raised += await this.alertExited(container, runtime?.exitCode ?? null, wasRunning, now);
        }
      }

      this.previous.set(container.id, state);
    }

    return raised;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.poll().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'container watcher failed');
      });
    }, this.intervalMs);

    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ----------------------------------------------------------------- private

  private async alertRestartLoop(container: ContainerSummary, now: number): Promise<number> {
    if (this.reported.has(container.id)) return 0;
    this.reported.add(container.id);

    const runtime = await this.docker.containerRuntime(container.id).catch(() => null);
    const restartCount = runtime?.restartCount ?? null;

    await this.notifications.notify({
      event: 'container.restart_loop',
      severity: 'error',
      title: `${container.name} is restarting in a loop`,
      body:
        `Container ${container.name} (${container.image}) keeps exiting and restarting` +
        `${restartCount !== null ? ` — ${restartCount} restarts so far` : ''}. ` +
        'Open Containers → logs to see why.',
      dedupeKey: `container.restart:${container.id}`,
      meta: { containerId: container.id, project: container.labels['capturehost.project'] ?? null },
    });

    this.logger.warn({ container: container.name, restartCount }, 'container restart loop');
    void now;
    return 1;
  }

  private async alertExited(
    container: ContainerSummary,
    exitCode: number | null,
    wasRunning: boolean,
    now: number,
  ): Promise<number> {
    this.reported.add(container.id);

    await this.notifications.notify({
      event: 'container.exited',
      severity: 'error',
      title: `${container.name} exited`,
      body:
        `Container ${container.name} (${container.image}) stopped` +
        `${exitCode !== null ? ` with exit code ${exitCode}` : ''}` +
        `${wasRunning ? ' after it had been running' : ' during startup'}.`,
      dedupeKey: `container.exited:${container.id}`,
      meta: { containerId: container.id, exitCode },
    });

    this.logger.warn({ container: container.name, exitCode, wasRunning }, 'managed container exited');
    void now;
    return 1;
  }
}
