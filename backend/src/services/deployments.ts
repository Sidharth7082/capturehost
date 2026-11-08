import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import type Docker from 'dockerode';
import type { AppConfig } from '../config.js';
import { writeAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import {
  appendDeploymentLog,
  createDeployment,
  getDeployment,
  getProject,
  listDeployments,
  previousSuccessfulDeployment,
  setProjectRuntime,
  updateDeployment,
  type DeploymentRow,
  type ProjectRow,
} from '../db/projects.repo.js';
import { decryptString } from '../crypto/secretbox.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';
import { assertDockerfilePresent, cloneRepository, removeWorkingTree } from './git.js';
import { buildContainerCreateOptions, clampResources } from './containerPolicy.js';

const run = promisify(execFile);

/**
 * The deployment pipeline.
 *
 * One build at a time, in a queue, because this is a laptop: two Docker builds
 * at once would fight over CPU and make both look broken.
 *
 * The swap is blue/green: the new container is created, started and health
 * checked *while the old one keeps serving*. Only then is the old container
 * stopped and removed. A failed health check therefore never drops the site —
 * the previous container is still there and the deployment is marked failed.
 */

export type LogLine = (line: string) => void;

/**
 * The slice of the Caddy service the pipeline needs. Kept narrow (and optional)
 * so the pipeline tests do not need a controller.
 */
export interface DomainRouter {
  applyRoutesForProject(projectId: number, port: number): Promise<void>;
  verifyHostname(hostname: string): Promise<{ ok: boolean; status: number | null; error: string | null }>;
}

export interface DeploymentServiceDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  /** Same dockerode client the rest of the app uses (proxy, never a socket). */
  client: Docker;
  /** Called with every log line so a WS subscriber can stream it live. */
  onLog?: (deploymentId: number, line: string) => void;
  /** Optional: when present, domains follow the blue/green swap. */
  caddy?: DomainRouter;
}

interface QueueEntry {
  deploymentId: number;
  projectId: number;
  mode: 'build' | 'rollback';
  imageTag?: string;
  commitSha?: string;
}

const TAR_MAX_BUFFER = 256 * 1024 * 1024;

export class DeploymentService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly client: Docker;

  private queue: QueueEntry[] = [];
  private running: QueueEntry | null = null;
  private cancelled = new Set<number>();
  private aborters = new Map<number, () => void>();
  private onLog?: (deploymentId: number, line: string) => void;
  private readonly caddy?: DomainRouter;

  constructor(deps: DeploymentServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger;
    this.client = deps.client;
    this.onLog = deps.onLog;
    this.caddy = deps.caddy;
  }

  isBusy(): boolean {
    return this.running !== null;
  }

  queueLength(): number {
    return this.queue.length;
  }

  // ------------------------------------------------------------------ public

  /** Queues a build from the project's branch. Returns the deployment id. */
  enqueueDeploy(project: ProjectRow, trigger: 'manual' | 'webhook'): number {
    const deploymentId = createDeployment(this.db, {
      projectId: project.id,
      commitSha: null,
      imageTag: null,
      status: 'queued',
      trigger,
      rollbackOf: null,
      now: Date.now(),
    });

    this.queue.push({ deploymentId, projectId: project.id, mode: 'build' });
    this.kick();
    return deploymentId;
  }

  /** Queues a re-run of a previously built image; no clone, no build. */
  enqueueRollback(project: ProjectRow, target: DeploymentRow): number {
    if (!target.image_tag) {
      throw AppError.badRequest('That deployment has no image to roll back to', 'no_rollback_target');
    }

    const deploymentId = createDeployment(this.db, {
      projectId: project.id,
      commitSha: target.commit_sha,
      imageTag: target.image_tag,
      status: 'queued',
      trigger: 'rollback',
      rollbackOf: target.id,
      now: Date.now(),
    });

    this.queue.push({
      deploymentId,
      projectId: project.id,
      mode: 'rollback',
      imageTag: target.image_tag,
      commitSha: target.commit_sha ?? undefined,
    });
    this.kick();
    return deploymentId;
  }

  /**
   * Cancels a queued or running deployment.
   * A queued one is dropped immediately; a running one is asked to stop at the
   * next checkpoint, and its build stream is destroyed.
   */
  cancel(deploymentId: number): void {
    const deployment = getDeployment(this.db, deploymentId);
    if (!deployment) throw AppError.notFound('Deployment not found');

    const terminal = ['live', 'failed', 'cancelled', 'rolled-back'];
    if (terminal.includes(deployment.status)) {
      throw AppError.conflict('That deployment has already finished', 'already_finished');
    }

    this.cancelled.add(deploymentId);
    this.queue = this.queue.filter((entry) => entry.deploymentId !== deploymentId);

    this.aborters.get(deploymentId)?.();

    if (this.running?.deploymentId !== deploymentId) {
      this.finish(deploymentId, 'cancelled', 'Cancelled before it started');
    }
  }

  // ----------------------------------------------------------------- private

  private kick(): void {
    if (this.running !== null) return;
    const next = this.queue.shift();
    if (!next) return;

    this.running = next;
    void this.execute(next)
      .catch((error: unknown) => {
        this.logger.error({ err: error, deploymentId: next.deploymentId }, 'deployment crashed');
        this.finish(next.deploymentId, 'failed', error instanceof Error ? error.message : 'Deployment failed');
      })
      .finally(() => {
        this.running = null;
        this.aborters.delete(next.deploymentId);
        this.kick();
      });
  }

  private isCancelled(deploymentId: number): boolean {
    return this.cancelled.has(deploymentId);
  }

  private log(deploymentId: number, message: string): void {
    const line = `${new Date().toISOString().slice(11, 19)}  ${message}`;
    appendDeploymentLog(this.db, deploymentId, `${line}\n`, this.config.deploy.maxLogBytes);
    this.onLog?.(deploymentId, line);
  }

  private setState(deploymentId: number, status: Parameters<typeof updateDeployment>[2]['status']): void {
    updateDeployment(this.db, deploymentId, { status });
  }

  private finish(deploymentId: number, status: Parameters<typeof updateDeployment>[2]['status'], error?: string): void {
    const deployment = getDeployment(this.db, deploymentId);
    const now = Date.now();
    updateDeployment(this.db, deploymentId, {
      status,
      finishedAt: now,
      ...(deployment?.started_at ? { durationMs: now - deployment.started_at } : {}),
      ...(error === undefined ? {} : { error }),
    });

    if (error) this.log(deploymentId, `FAILED: ${error}`);
  }

  private async execute(entry: QueueEntry): Promise<void> {
    const project = getProject(this.db, entry.projectId);
    if (!project) {
      this.finish(entry.deploymentId, 'failed', 'Project no longer exists');
      return;
    }

    updateDeployment(this.db, entry.deploymentId, { startedAt: Date.now() });

    try {
      if (entry.mode === 'rollback') {
        await this.runRollback(entry, project);
      } else {
        await this.runBuild(entry, project);
      }
    } catch (error) {
      if (this.isCancelled(entry.deploymentId)) {
        this.finish(entry.deploymentId, 'cancelled', 'Cancelled');
        await this.cleanupNewContainer(entry.deploymentId);
        return;
      }
      const message = error instanceof Error ? error.message : 'Deployment failed';
      this.finish(entry.deploymentId, 'failed', networkHint(message));
      await this.cleanupNewContainer(entry.deploymentId);
      setProjectRuntime(this.db, project.id, { status: 'failed' }, Date.now());
      writeAudit(this.db, {
        action: 'deploy.failed',
        actor: 'system',
        target: `${project.name} #${entry.deploymentId}`,
        detail: message.slice(0, 200),
        success: false,
      });
    }
  }

  private async runBuild(entry: QueueEntry, project: ProjectRow): Promise<void> {
    const workRoot = resolve(this.config.deploy.dataDir, String(project.id));
    const workDir = join(workRoot, `dep-${entry.deploymentId}`);
    mkdirSync(workRoot, { recursive: true });

    try {
      // ---- clone ----
      this.checkpoint(entry.deploymentId);
      this.setState(entry.deploymentId, 'cloning');
      setProjectRuntime(this.db, project.id, { status: 'deploying' }, Date.now());
      this.log(entry.deploymentId, `Cloning ${project.repo_url} (branch ${project.branch}, depth 1)`);

      const clone = await cloneRepository({
        repoUrl: project.repo_url,
        branch: project.branch,
        destDir: workDir,
        token: this.decryptToken(project),
        timeoutMs: this.config.deploy.gitTimeoutMs,
        maxBytes: this.config.deploy.maxCloneBytes,
        logger: this.logger,
      });

      this.log(entry.deploymentId, `Cloned commit ${clone.shortSha} (${(clone.sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
      updateDeployment(this.db, entry.deploymentId, { commitSha: clone.commitSha });

      assertDockerfilePresent(clone.path, project.dockerfile_path);

      // ---- build ----
      this.checkpoint(entry.deploymentId);
      this.setState(entry.deploymentId, 'building');

      const imageTag = `capturehost/${project.slug}:${clone.shortSha}`;
      this.log(entry.deploymentId, `Building image ${imageTag}`);
      await this.buildImage(entry.deploymentId, clone.path, imageTag, project.dockerfile_path);
      updateDeployment(this.db, entry.deploymentId, { imageTag });

      // ---- run ----
      await this.startAndSwap(entry, project, imageTag, clone.commitSha);

      // ---- housekeeping ----
      await this.pruneImages(project);
    } finally {
      removeWorkingTree(workDir);
    }
  }

  private async runRollback(entry: QueueEntry, project: ProjectRow): Promise<void> {
    const imageTag = entry.imageTag as string;
    this.setState(entry.deploymentId, 'starting');
    this.log(entry.deploymentId, `Rolling back to ${imageTag} (no rebuild)`);

    await this.startAndSwap(entry, project, imageTag, entry.commitSha ?? null);

    // The deployment we rolled away from is recorded as such, not deleted.
    const previousId = project.current_deployment_id;
    if (previousId !== null && previousId !== entry.deploymentId) {
      updateDeployment(this.db, previousId, { status: 'rolled-back' });
    }

    writeAudit(this.db, {
      action: 'deploy.rollback',
      actor: 'system',
      target: `${project.name} #${entry.deploymentId}`,
      detail: `back to ${imageTag}`,
    });
  }

  /** Creates, starts, health-checks and swaps in the new container. */
  private async startAndSwap(
    entry: QueueEntry,
    project: ProjectRow,
    imageTag: string,
    commitSha: string | null,
  ): Promise<void> {
    this.checkpoint(entry.deploymentId);
    this.setState(entry.deploymentId, 'starting');

    const baseHostPort = this.allocatePort(project);
    const resources = clampResources(
      { memoryLimitMb: project.memory_limit_mb, cpuLimit: project.cpu_limit, pidsLimit: project.pids_limit },
      this.config.deploy,
    );
    const env = this.readEnv(project.id);

    let hostPort = baseHostPort;
    let name = `capturehost-${project.slug}-${entry.deploymentId}`;
    let container: Awaited<ReturnType<Docker['createContainer']>> | null = null;

    // Blue/green needs a different host port than the container currently
    // serving, otherwise Docker refuses to publish it ("port is already
    // allocated"). So each deployment gets a fresh port from the range, and the
    // project's port column is updated after the swap. Caddy fronts the port in
    // Phase 5, so it is an internal detail.
    for (let attempt = 0; attempt < 6 && container === null; attempt += 1) {
      const built = buildContainerCreateOptions(
        {
          projectId: project.id,
          projectSlug: project.slug,
          deploymentId: entry.deploymentId,
          image: imageTag,
          containerPort: project.container_port,
          hostPort,
          env,
          memoryLimitMb: resources.memoryLimitMb,
          cpuLimit: resources.cpuLimit,
          pidsLimit: resources.pidsLimit,
          capabilities: project.capabilities.split(',').filter(Boolean),
        },
        this.config.deploy,
      );

      name = built.name;

      try {
        container = await this.client.createContainer(
          built.options as unknown as Docker.ContainerCreateOptions,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/port is already allocated|address already in use/i.test(message) && attempt < 5) {
          this.log(entry.deploymentId, `Host port ${hostPort} is busy, trying the next one`);
          hostPort = this.nextFreePort(hostPort);
          continue;
        }
        throw error;
      }
    }

    if (container === null) {
      throw new Error('Could not find a free host port for the new container');
    }

    this.log(
      entry.deploymentId,
      `Starting ${name} on 127.0.0.1:${hostPort} (${resources.memoryLimitMb} MB, ${resources.cpuLimit} cpu, ${resources.pidsLimit} pids)`,
    );

    const containerId = container.id;
    updateDeployment(this.db, entry.deploymentId, { containerId });

    // Remember what to kill if we bail out from here on.
    this.aborters.set(entry.deploymentId, () => {
      void this.client.getContainer(containerId).remove({ force: true }).catch(() => undefined);
    });

    await container.start();

    // ---- health check ----
    this.checkpoint(entry.deploymentId);
    this.setState(entry.deploymentId, 'health-check');
    this.log(entry.deploymentId, 'Waiting for the container to become healthy');

    await this.waitForHealth(name, hostPort, project.health_path, entry.deploymentId);

    // ---- domains ----
    // The route has to move to the new port while the old container is still
    // serving: if Caddy rejects it, we revert the route and keep the old
    // container alive instead of leaving the site pointed at a dead port.
    await this.moveDomains(project, hostPort, entry.deploymentId);

    // ---- swap ----
    const oldContainerId = project.container_id;
    setProjectRuntime(
      this.db,
      project.id,
      {
        status: 'running',
        hostPort,
        containerId: String(containerId),
        currentDeploymentId: entry.deploymentId,
        lastDeployedAt: Date.now(),
      },
      Date.now(),
    );

    if (oldContainerId && oldContainerId !== containerId) {
      this.log(entry.deploymentId, 'New container is healthy — stopping the previous one');
      try {
        const old = this.client.getContainer(oldContainerId);
        await old.stop({ t: 5 }).catch(() => undefined);
        await old.remove({ force: true }).catch(() => undefined);
      } catch (error) {
        this.logger.warn({ err: error }, 'could not remove the previous container');
      }
    }

    this.finish(entry.deploymentId, 'live');
    this.log(entry.deploymentId, `Live on http://127.0.0.1:${hostPort}`);

    writeAudit(this.db, {
      action: 'deploy.success',
      actor: 'system',
      target: `${project.name} #${entry.deploymentId}`,
      detail: `${imageTag} on port ${hostPort}`,
    });

    if (commitSha) {
      this.logger.info({ project: project.slug, commitSha: commitSha.slice(0, 7) }, 'deployment live');
    }
  }

  // ------------------------------------------------------------- primitives

  /**
   * Points every enabled domain at the new port and proves it answers.
   * Throws (which fails the deployment) when Caddy or the route misbehaves;
   * the caller has already reverted the upstream by then.
   */
  private async moveDomains(project: ProjectRow, newPort: number, deploymentId: number): Promise<void> {
    if (!this.caddy) return;

    const domains = this.db
      .prepare('SELECT id, hostname FROM domains WHERE project_id = ? AND enabled = 1')
      .all(project.id) as { id: number; hostname: string }[];

    if (domains.length === 0) return;

    try {
      await this.caddy.applyRoutesForProject(project.id, newPort);

      for (const domain of domains) {
        const probe = await this.caddy.verifyHostname(domain.hostname);
        if (!probe.ok) {
          throw new Error(
            `${domain.hostname} did not answer through Caddy (${probe.error ?? `HTTP ${probe.status}`})`,
          );
        }
      }

      this.log(deploymentId, `Domains updated: ${domains.map((domain) => domain.hostname).join(', ')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'domain update failed';

      // Put the routes back on the container that is still running.
      if (project.host_port !== null) {
        await this.caddy.applyRoutesForProject(project.id, project.host_port).catch(() => undefined);
      }

      throw new Error(`Domain update failed, keeping the previous container: ${message}`);
    }
  }

  private checkpoint(deploymentId: number): void {
    if (this.isCancelled(deploymentId)) {
      throw new Error('Cancelled');
    }
  }

  private async buildImage(deploymentId: number, contextDir: string, tag: string, dockerfile: string): Promise<void> {
    const tar = await this.tarContext(contextDir);

    const stream = await this.client.buildImage(tar, {
      t: tag,
      dockerfile,
      // No network tricks, no build args: the Dockerfile gets what it gets.
      pull: false,
      rm: true,
      forcerm: true,
    });

    await new Promise<void>((resolve, reject) => {
      let lastLine = '';
      const timeout = setTimeout(() => {
        (stream as unknown as { destroy?: () => void }).destroy?.();
        reject(new Error(`Build exceeded the ${Math.round(this.config.deploy.buildTimeoutMs / 60000)} minute limit`));
      }, this.config.deploy.buildTimeoutMs);

      const done = (error?: Error): void => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };

      stream.on('data', (chunk: Buffer) => {
        for (const line of parseBuildOutput(chunk)) {
          // Docker repeats "Downloading" hundreds of times per pull; keep the
          // log readable by collapsing consecutive identical lines.
          if (line === lastLine) continue;
          lastLine = line;
          this.log(deploymentId, line);
        }
      });
      stream.on('error', (error: Error) => done(error));
      stream.on('end', () => done());
    });

    // A build can "succeed" with an error embedded in its stream; verify the
    // image really exists before pretending it does.
    try {
      await this.client.getImage(tag).inspect();
    } catch {
      throw new Error('Build finished without producing an image');
    }
  }

  /** Tars the context without .git, using the system tar through execFile. */
  private async tarContext(dir: string): Promise<NodeJS.ReadableStream> {
    const { stdout } = await run('tar', ['-cf', '-', '--exclude=./.git', '--exclude=.git', '.'], {
      cwd: dir,
      maxBuffer: TAR_MAX_BUFFER,
      encoding: 'buffer',
    });

    const stream = new PassThrough();
    stream.end(stdout);
    return stream;
  }

  private async waitForHealth(
    containerName: string,
    hostPort: number,
    healthPath: string | null,
    deploymentId: number,
  ): Promise<void> {
    const deadline = Date.now() + this.config.deploy.healthCheckTimeoutMs;
    // Give the process a moment to fail fast on a bad entrypoint. Scaled to the
    // configured timeout so a short test/budget timeout is not eaten by a fixed
    // sleep before the first probe.
    const initialDelay = Math.min(2500, Math.max(250, Math.floor(this.config.deploy.healthCheckTimeoutMs / 8)));
    await sleep(initialDelay);
    let steadySamples = 0;

    while (Date.now() < deadline) {
      if (this.isCancelled(deploymentId)) throw new Error('Cancelled');

      let running = false;
      try {
        const info = await this.client.getContainer(containerName).inspect();
        const state = (info.State ?? {}) as {
          Running?: boolean;
          Restarting?: boolean;
          Status?: string;
          ExitCode?: number;
        };

        // A crash-looping container is briefly "Running" between restarts, so
        // Restarting/restarting has to count as failure, not as readiness.
        if (state.Restarting === true || state.Status === 'restarting') {
          throw new Error('Container is in a restart loop — it exits immediately (check its logs)');
        }

        running = Boolean(state.Running);
        if (!running) {
          const exit = state.ExitCode ?? 'unknown';
          throw new Error(`Container exited during startup (code ${exit})`);
        }
      } catch (error) {
        if (error instanceof Error && /restart loop|exited during startup/.test(error.message)) throw error;
        // inspect failed: treat as not ready yet
      }

      if (running) {
        if (!healthPath) {
          // No HTTP probe configured: require the process to stay up across two
          // samples instead of trusting a single instant.
          steadySamples += 1;
          if (steadySamples >= 2) return;
        } else {
          try {
            const response = await fetch(`http://127.0.0.1:${hostPort}${healthPath}`, {
              signal: AbortSignal.timeout(2000),
            });
            if (response.status >= 200 && response.status < 300) {
              this.log(deploymentId, `Health check ${healthPath} -> ${response.status}`);
              return;
            }
          } catch {
            // not listening yet
          }
        }
      }

      await sleep(1000);
    }

    throw new Error(`Health check did not pass within ${Math.round(this.config.deploy.healthCheckTimeoutMs / 1000)}s`);
  }

  private async cleanupNewContainer(deploymentId: number): Promise<void> {
    const deployment = getDeployment(this.db, deploymentId);
    if (!deployment?.image_tag) return;

    const project = getProject(this.db, deployment.project_id);
    if (!project) return;

    const name = `capturehost-${project.slug}-${deploymentId}`;
    try {
      await this.client.getContainer(name).remove({ force: true });
      this.log(deploymentId, 'Removed the failed container');
    } catch {
      /* never existed, or already gone */
    }
  }

  private async pruneImages(project: ProjectRow): Promise<void> {
    try {
      const images = await this.client.listImages();
      const prefix = `capturehost/${project.slug}:`;

      const ours = images
        .filter((image) => (image.RepoTags ?? []).some((tag) => tag.startsWith(prefix)))
        .sort((a, b) => (b.Created ?? 0) - (a.Created ?? 0));

      for (const image of ours.slice(this.config.deploy.keepImages)) {
        for (const tag of image.RepoTags ?? []) {
          if (!tag.startsWith(prefix)) continue;
          await this.client.getImage(tag).remove({ force: true }).catch(() => undefined);
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'image pruning failed');
    }
  }

  private usedPorts(): Set<number> {
    const rows = this.db.prepare('SELECT host_port FROM projects WHERE host_port IS NOT NULL').all() as {
      host_port: number;
    }[];
    return new Set(rows.map((row) => row.host_port));
  }

  /** Next free port after `from`, wrapping at the end of the range. */
  private nextFreePort(from: number): number {
    const { portRangeStart, portRangeEnd } = this.config.deploy;
    const used = this.usedPorts();

    for (let port = from + 1; port <= portRangeEnd; port += 1) {
      if (!used.has(port)) return port;
    }
    for (let port = portRangeStart; port < from; port += 1) {
      if (!used.has(port)) return port;
    }

    throw AppError.conflict('No free host port in the configured range', 'no_free_port');
  }

  private allocatePort(project: ProjectRow): number {
    const { portRangeStart, portRangeEnd } = this.config.deploy;
    const used = this.usedPorts();

    // Reuse the current port only when nothing is holding it: a container that
    // is still serving keeps its published port until the swap.
    const heldByLiveContainer = project.container_id !== null;
    if (!heldByLiveContainer && project.host_port !== null) {
      if (project.host_port >= portRangeStart && project.host_port <= portRangeEnd && !used.has(project.host_port)) {
        return project.host_port;
      }
      if (project.host_port >= portRangeStart && project.host_port <= portRangeEnd) {
        return project.host_port;
      }
    }

    for (let port = portRangeStart; port <= portRangeEnd; port += 1) {
      if (!used.has(port)) return port;
    }

    throw AppError.conflict('No free host port in the configured range', 'no_free_port');
  }

  private decryptToken(project: ProjectRow): string | null {
    if (!project.github_token_encrypted) return null;
    try {
      return decryptString(project.github_token_encrypted, this.config.encryptionKey, 'project.github_token');
    } catch {
      this.logger.error({ projectId: project.id }, 'stored GitHub token could not be decrypted');
      return null;
    }
  }

  private readEnv(projectId: number): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value_encrypted FROM env_vars WHERE project_id = ?').all(projectId) as {
      key: string;
      value_encrypted: string;
    }[];

    const env: Record<string, string> = {};
    for (const row of rows) {
      try {
        env[row.key] = decryptString(row.value_encrypted, this.config.encryptionKey, `project.env.${row.key}`);
      } catch {
        this.logger.error({ projectId, key: row.key }, 'env var could not be decrypted');
      }
    }
    return env;
  }

  /** Most recent live deployment, used by rollback. */
  latestRollbackTarget(projectId: number, excludeId?: number): DeploymentRow | null {
    return previousSuccessfulDeployment(this.db, projectId, excludeId);
  }

  history(projectId: number): DeploymentRow[] {
    return listDeployments(this.db, projectId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Docker's "network not found" error is accurate but useless to the operator.
 * Point at the command that fixes it instead.
 */
export function networkHint(message: string): string {
  if (/network .* not found|no such network/i.test(message)) {
    return 'The capturehost-apps network does not exist. Run: docker compose -f docker-compose.dev.yml up -d';
  }
  return message;
}

/** Docker's build stream is concatenated JSON objects, not newline-delimited. */
export function parseBuildOutput(chunk: Buffer): string[] {
  const text = chunk.toString('utf8');
  const lines: string[] = [];

    for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    try {
      const parsed = JSON.parse(trimmed) as { stream?: string; status?: string; error?: string };
      if (parsed.error) lines.push(`ERROR: ${parsed.error}`);
      else if (parsed.stream) lines.push(parsed.stream.replace(/\n$/, ''));
      else if (parsed.status) lines.push(parsed.status);
    } catch {
      // A partial JSON object split across chunks: show it raw rather than lose it.
      lines.push(trimmed.slice(0, 500));
    }
  }

  return lines;
}

/** Used by the routes for port bookkeeping when a project is edited. */
export function freePortInRange(start: number, end: number, used: number[]): number | null {
  const taken = new Set(used);
  for (let port = start; port <= end; port += 1) {
    if (!taken.has(port)) return port;
  }
  return null;
}

export { rmSync };
