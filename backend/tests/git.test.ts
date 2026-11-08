import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BranchSchema,
  DockerfilePathSchema,
  RepoUrlSchema,
  assertDockerfilePresent,
  assertNoEscapingSymlinks,
} from '../src/services/git.js';
import { parseBuildOutput } from '../src/services/deployments.js';

/**
 * Git input is the most obvious injection surface in the project: it becomes
 * an argv array and, indirectly, a Docker build. These tests pin the URL,
 * branch and path rules, plus the symlink escape check.
 */

describe('RepoUrlSchema', () => {
  const accepted = [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/Sidharth7082/capturehost-test-app',
    'https://github.com/some-org/some.repo_name-1',
  ];

  for (const url of accepted) {
    it(`accepts ${url}`, () => {
      expect(RepoUrlSchema.safeParse(url).success).toBe(true);
    });
  }

  const rejected: Array<[string, string]> = [
    ['ssh URL', 'git@github.com:owner/repo.git'],
    ['ssh scheme', 'ssh://git@github.com/owner/repo.git'],
    ['git scheme', 'git://github.com/owner/repo.git'],
    ['file scheme', 'file:///etc/passwd'],
    ['local path', '/home/capture/repo'],
    ['http (not https)', 'http://github.com/owner/repo'],
    ['another host', 'https://gitlab.com/owner/repo'],
    ['lookalike host', 'https://github.com.evil.example/owner/repo'],
    ['option injection', '--upload-pack=/bin/sh'],
    ['url with option', 'https://github.com/owner/repo --upload-pack=/bin/sh'],
    ['command substitution', 'https://github.com/owner/$(whoami)'],
    ['path traversal', 'https://github.com/owner/../../etc'],
    ['too many segments', 'https://github.com/owner/repo/tree/main'],
    ['empty', ''],
  ];

  for (const [label, url] of rejected) {
    it(`rejects ${label}`, () => {
      expect(RepoUrlSchema.safeParse(url).success).toBe(false);
    });
  }
});

describe('BranchSchema', () => {
  it('accepts normal branch names', () => {
    for (const branch of ['main', 'master', 'release/1.2', 'feature-x', 'fix_thing']) {
      expect(BranchSchema.safeParse(branch).success, branch).toBe(true);
    }
  });

  it('rejects option-like and traversal values', () => {
    for (const branch of ['--upload-pack=x', '-u', '../main', 'a..b', 'branch name', 'a;rm -rf /']) {
      expect(BranchSchema.safeParse(branch).success, branch).toBe(false);
    }
  });
});

describe('DockerfilePathSchema', () => {
  it('accepts a nested path inside the repository', () => {
    expect(DockerfilePathSchema.safeParse('Dockerfile').success).toBe(true);
    expect(DockerfilePathSchema.safeParse('docker/Dockerfile.prod').success).toBe(true);
  });

  it('rejects absolute paths and traversal', () => {
    for (const path of ['/etc/passwd', '../Dockerfile', 'a/../../b', 'Docker file', 'Dockerfile;rm']) {
      expect(DockerfilePathSchema.safeParse(path).success, path).toBe(false);
    }
  });
});

describe('filesystem checks', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a symlink that stays inside the build context', () => {
    dir = mkdtempSync(join(tmpdir(), 'capturehost-git-'));
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'app.conf'), 'ok');
    symlinkSync(join(dir, 'config'), join(dir, 'linked-config'));

    expect(() => assertNoEscapingSymlinks(dir)).not.toThrow();
  });

  it('rejects a symlink pointing outside the build context', () => {
    dir = mkdtempSync(join(tmpdir(), 'capturehost-git-'));
    symlinkSync('/etc', join(dir, 'etc-link'));

    expect(() => assertNoEscapingSymlinks(dir)).toThrow(/escaping the build context/);
  });

  it('requires the Dockerfile to exist as a regular file', () => {
    dir = mkdtempSync(join(tmpdir(), 'capturehost-git-'));
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');

    expect(() => assertDockerfilePresent(dir, 'Dockerfile')).not.toThrow();
    expect(() => assertDockerfilePresent(dir, 'Dockerfile.missing')).toThrow(/No Dockerfile/);
  });

  it('refuses a Dockerfile that is a symlink', () => {
    dir = mkdtempSync(join(tmpdir(), 'capturehost-git-'));
    writeFileSync(join(dir, 'real.Dockerfile'), 'FROM scratch\n');
    symlinkSync(join(dir, 'real.Dockerfile'), join(dir, 'Dockerfile'));

    expect(() => assertDockerfilePresent(dir, 'Dockerfile')).toThrow(/symlink/);
  });
});

describe('parseBuildOutput', () => {
  it('extracts stream and status lines from Docker JSON', () => {
    const chunk = Buffer.from(
      [
        JSON.stringify({ stream: 'Step 1/3 : FROM nginx:alpine\n' }),
        JSON.stringify({ status: 'Pulling from library/nginx' }),
        JSON.stringify({ error: 'executor failed' }),
      ].join('\r\n'),
    );

    expect(parseBuildOutput(chunk)).toEqual([
      'Step 1/3 : FROM nginx:alpine',
      'Pulling from library/nginx',
      'ERROR: executor failed',
    ]);
  });

  it('keeps a partial JSON line readable instead of dropping it', () => {
    const lines = parseBuildOutput(Buffer.from('{"stream":"half a li'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('half a li');
  });

  it('ignores blank lines', () => {
    expect(parseBuildOutput(Buffer.from('\n\n'))).toEqual([]);
  });
});
