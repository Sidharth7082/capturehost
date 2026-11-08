import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, lstatSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';

const run = promisify(execFile);

/**
 * Git access for deployments.
 *
 * Rules, all of them load-bearing:
 *  - https://github.com/<owner>/<repo> only. No ssh://, no git://, no file://,
 *    no local paths — those are either credential-bound or host reads.
 *  - execFile with an argument array. No shell, ever.
 *  - the URL comes after `--` so a value starting with a dash cannot become a
 *    git option.
 *  - shallow, single-branch, no tags, no submodules, hard timeout.
 *  - a GitHub token is passed to git through a throwaway askpass script, never
 *    in the URL and never in argv (so it cannot show up in `ps` or the log).
 */

export const GITHUB_REPO_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/;

export const RepoUrlSchema = z
  .string()
  .trim()
  .min(10)
  .max(300)
  .regex(GITHUB_REPO_PATTERN, 'Only https://github.com/owner/repo URLs are supported');

/** Branch names git accepts in practice, minus anything that looks like a flag. */
export const BranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._\/-]+$/, 'Branch name contains invalid characters')
  .refine((value) => !value.startsWith('-') && !value.includes('..'), 'Branch name is not allowed');

export const DockerfilePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._\-\/]+$/, 'Dockerfile path contains invalid characters')
  .refine((value) => !value.startsWith('/') && !value.includes('..'), 'Dockerfile path must stay inside the repository');

export interface CloneOptions {
  repoUrl: string;
  branch: string;
  destDir: string;
  token: string | null;
  timeoutMs: number;
  maxBytes: number;
  logger: Logger;
}

export interface CloneResult {
  commitSha: string;
  shortSha: string;
  sizeBytes: number;
  /** Absolute path of the cloned working tree. */
  path: string;
}

function gitEnv(token: string | null, askpassDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Never wait for a human: a prompt means a hang, and a hang means a stuck build.
    GIT_TERMINAL_PROMPT: '0',
    // Ignore any interactive askpass the machine might have configured.
    GIT_ASKPASS: token && askpassDir ? join(askpassDir, 'askpass.sh') : '/bin/true',
    GCM_INTERACTIVE: 'never',
  };

  if (token && askpassDir) {
    env.GIT_TOKEN = token;
  }

  return env;
}

/** Writes a 0700 askpass script; it prints the token git asks for. */
function writeAskpass(dir: string): void {
  const script = join(dir, 'askpass.sh');
  writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "$GIT_TOKEN"\n', { mode: 0o700 });
  chmodSync(script, 0o700);
}

function directorySize(dir: string): number {
  let total = 0;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // counted later by the escape check
    if (entry.isDirectory()) total += directorySize(full);
    else total += statSync(full).size;
  }

  return total;
}

/**
 * Refuses symlinks that point outside the build context.
 *
 * A repo could otherwise contain `app -> /etc` and have the Dockerfile COPY it.
 */
export function assertNoEscapingSymlinks(root: string): void {
  const realRoot = realpathSync(root);

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          continue; // dangling symlink: harmless, the COPY will fail loudly
        }
        if (target !== realRoot && !target.startsWith(realRoot + sep)) {
          throw AppError.badRequest(
            `Repository contains a symlink escaping the build context (${entry.name})`,
            'unsafe_symlink',
          );
        }
        continue;
      }

      if (entry.isDirectory() && entry.name !== '.git') walk(full);
    }
  };

  walk(root);
}

export async function cloneRepository(options: CloneOptions): Promise<CloneResult> {
  const repoUrl = RepoUrlSchema.parse(options.repoUrl);
  const branch = BranchSchema.parse(options.branch);

  mkdirSync(options.destDir, { recursive: true });
  const askpassDir = options.token ? mkdtempSync(join(options.destDir, '..', 'askpass-')) : undefined;
  if (askpassDir) writeAskpass(askpassDir);

  const args = [
    // No credential helper: a cached credential must not silently change who
    // we are authenticating as.
    '-c', 'credential.helper=',
    'clone',
    '--depth', '1',
    '--single-branch',
    '--no-tags',
    '--branch', branch,
    '--quiet',
    // Keep the URL after -- so a leading dash can never be parsed as a flag.
    '--',
    repoUrl,
    options.destDir,
  ];

  try {
    await run('git', args, {
      env: gitEnv(options.token, askpassDir),
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      // Run from the parent, not from the destination: git resolves a relative
      // destination against its cwd, so cwd = destDir would nest the clone.
      cwd: dirname(options.destDir),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'git clone failed';
    // Auth failures are the common case for private repos; say so without
    // echoing anything the token could appear in.
    const hint = /Authentication failed|could not read Username|repository not found|403/i.test(message)
      ? 'Repository not found, or the access token is missing/invalid for it'
      : 'Clone failed';

    options.logger.warn({ repoUrl, branch, err: message }, 'git clone failed');
    throw AppError.badRequest(hint, 'clone_failed');
  } finally {
    if (askpassDir) {
      try {
        rmSync(askpassDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  const sizeBytes = directorySize(options.destDir);
  if (sizeBytes > options.maxBytes) {
    rmSync(options.destDir, { recursive: true, force: true });
    throw AppError.badRequest(
      `Repository is larger than the configured limit (${Math.round(options.maxBytes / 1024 / 1024)} MB)`,
      'repo_too_large',
    );
  }

  assertNoEscapingSymlinks(options.destDir);

  let commitSha: string;
  try {
    const { stdout } = await run('git', ['-C', options.destDir, 'rev-parse', 'HEAD'], {
      timeout: 10_000,
    });
    commitSha = stdout.trim();
  } catch {
    throw AppError.badRequest('Could not read the commit id from the clone', 'clone_failed');
  }

  return {
    commitSha,
    shortSha: commitSha.slice(0, 7),
    sizeBytes,
    path: resolve(options.destDir),
  };
}

export function removeWorkingTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the operator can clean ./data/deployments by hand */
  }
}

/** Validates the Dockerfile exists and is a regular file inside the clone. */
export function assertDockerfilePresent(workDir: string, dockerfilePath: string): string {
  const full = resolve(workDir, DockerfilePathSchema.parse(dockerfilePath));

  if (!full.startsWith(realpathSync(workDir))) {
    throw AppError.badRequest('Dockerfile path escapes the repository', 'unsafe_dockerfile_path');
  }

  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    throw AppError.badRequest(`No Dockerfile at "${dockerfilePath}" in this repository`, 'dockerfile_missing');
  }

  if (stat.isSymbolicLink()) {
    throw AppError.badRequest('Dockerfile must be a regular file, not a symlink', 'unsafe_dockerfile_path');
  }
  if (!stat.isFile()) {
    throw AppError.badRequest(`"${dockerfilePath}" is not a file`, 'dockerfile_missing');
  }

  return full;
}
