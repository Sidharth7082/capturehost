import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/connection.js';
import { clearDockerfileOverride, getDockerfileOverride, setDockerfileOverride } from '../db/dockerfile.repo.js';
import { getProject } from '../db/projects.repo.js';
import { writeAudit } from '../db/audit.repo.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppInstance } from '../server.js';
import { cloneRepository, removeWorkingTree } from '../services/git.js';
import { readFingerprint, suggestDockerfile } from '../services/dockerfileSuggestion.js';
import { AppError } from '../utils/errors.js';
import type { SessionRateLimiter } from '../utils/rateLimit.js';
import type { Logger } from '../logger.js';

/**
 * Dockerfiles for repositories that do not have one.
 *
 * `POST …/suggest` clones the repository read-only, looks at its manifests and
 * returns a Dockerfile to review. Nothing is written anywhere until the operator
 * (or an agent with a deploy token) explicitly saves it, and even then the
 * repository's own Dockerfile still wins at build time.
 */

const IdParam = z.object({ id: z.coerce.number().int().positive() });

/** A Dockerfile is text someone will read; 64 KB is already absurd for one. */
const MAX_DOCKERFILE_BYTES = 64 * 1024;

export interface DockerfileRoutesDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  /** Cloning is the expensive part, so suggestions get their own small budget. */
  limiter: SessionRateLimiter;
}

/**
 * Clone the repository, read its fingerprint, suggest a Dockerfile.
 *
 * Shared by the dashboard route and the agent tool so the two can never disagree.
 * The caller owns nothing: the working directory is created and removed here.
 */
export async function suggestForProject(
  deps: Pick<DockerfileRoutesDeps, 'config' | 'logger'>,
  project: { id: number; repo_url: string; branch: string; container_port: number; slug: string },
): Promise<{ suggestion: ReturnType<typeof suggestDockerfile>; files: string[]; commit: string }> {
  const workDir = resolve(deps.config.deploy.dataDir, 'suggest', String(project.id), String(Date.now()));
  mkdirSync(workDir, { recursive: true });

  try {
    const clone = await cloneRepository({
      repoUrl: project.repo_url,
      branch: project.branch,
      destDir: join(workDir, 'repo'),
      token: null,
      timeoutMs: deps.config.deploy.gitTimeoutMs,
      maxBytes: deps.config.deploy.maxCloneBytes,
      logger: deps.logger,
    });

    const fingerprint = readFingerprint(join(workDir, 'repo'), {
      containerPort: project.container_port,
      projectName: project.slug,
    });

    return { suggestion: suggestDockerfile(fingerprint), files: fingerprint.files.slice(0, 60), commit: clone.shortSha };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function registerDockerfileRoutes(app: AppInstance, deps: DockerfileRoutesDeps): void {
  const projectOr404 = (id: number) => {
    const project = getProject(deps.db, id);
    if (!project) throw AppError.notFound('Project not found');
    return project;
  };

  /** Read-only: clones, inspects, returns text. Safe to call from a read token. */
  app.post('/api/projects/:id/dockerfile/suggest', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const project = projectOr404(id);

    const rate = deps.limiter.consume(`dockerfile:${session.username}`);
    if (!rate.allowed) {
      throw new AppError(429, 'rate_limited', 'Too many suggestions. Wait a minute.', {
        'retry-after': String(rate.retryAfterSeconds),
      });
    }

    const { suggestion, files, commit } = await suggestForProject(deps, project);

    writeAudit(deps.db, {
      action: 'project.dockerfile_suggested',
      actor: session.username,
      target: project.name,
      detail: suggestion ? `${suggestion.stack} (${suggestion.confidence})` : 'no known stack',
      ip: request.ip ?? null,
    });

    if (!suggestion) {
      return {
        suggestion: null,
        reason:
          'No stack CaptureHost recognises (no package.json, requirements.txt, pyproject.toml, go.mod, composer.json, Gemfile, Cargo.toml or index.html at the top level).',
        files,
      };
    }

    return { suggestion, commit, files };
  });

  app.get('/api/projects/:id/dockerfile', async (request) => {
    requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const project = projectOr404(id);
    const override = getDockerfileOverride(deps.db, project.id);

    return {
      dockerfilePath: project.dockerfile_path,
      override,
    };
  });

  app.put('/api/projects/:id/dockerfile', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const project = projectOr404(id);

    const body = z
      .object({
        content: z.string().min(1).max(MAX_DOCKERFILE_BYTES),
        source: z.enum(['generated', 'edited']).default('edited'),
      })
      .parse(request.body ?? {});

    if (!/\bFROM\b/i.test(body.content)) {
      throw AppError.badRequest('A Dockerfile needs at least one FROM instruction', 'invalid_dockerfile');
    }

    setDockerfileOverride(deps.db, project.id, body.content, body.source);
    writeAudit(deps.db, {
      action: 'project.dockerfile_saved',
      actor: session.username,
      target: project.name,
      detail: `${body.source}, ${body.content.split('\n').length} lines`,
      ip: request.ip ?? null,
    });

    return { saved: true, override: getDockerfileOverride(deps.db, project.id) };
  });

  app.delete('/api/projects/:id/dockerfile', async (request) => {
    const session = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const project = projectOr404(id);

    const cleared = clearDockerfileOverride(deps.db, project.id);
    if (cleared) {
      writeAudit(deps.db, {
        action: 'project.dockerfile_cleared',
        actor: session.username,
        target: project.name,
        detail: 'reverted to the repository Dockerfile',
        ip: request.ip ?? null,
      });
    }
    return { cleared };
  });
}
