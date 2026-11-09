import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFingerprint, suggestDockerfile } from '../src/services/dockerfileSuggestion.js';
import { applyDockerfileOverride } from '../src/services/dockerfileOverride.js';
import { startApp, type AuthedApp } from './appHarness.js';

/**
 * Dockerfile generation and the override rules.
 *
 * The generator is a lookup table over manifests, so it is tested by building real
 * directory layouts in a temp dir — the same code path the route uses, without a
 * network clone.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ch-df-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
}

const suggest = (port = 8000) =>
  suggestDockerfile(readFingerprint(root, { containerPort: port, projectName: 'demo' }));

describe('the generator', () => {
  it('writes a Flask/gunicorn image that honours the project port', () => {
    write({
      'app.py': 'from flask import Flask\napp = Flask(__name__)\n',
      'requirements.txt': 'Flask\nFlask-Cors\ngunicorn\n',
      'Procfile': 'web: gunicorn app:app\n',
    });

    const result = suggest(8000);
    expect(result?.stack).toBe('python:flask');
    expect(result?.dockerfile).toContain('FROM python:3.12-slim');
    expect(result?.dockerfile).toContain('gunicorn');
    expect(result?.dockerfile).toContain('app:app');
    expect(result?.dockerfile).toContain('0.0.0.0:8000');
    expect(result?.confidence).toBe('high');
    // Non-root, always.
    expect(result?.dockerfile).toMatch(/USER app/);
  });

  it('installs build tools only when a dependency usually needs a compiler', () => {
    write({ 'app.py': '', 'requirements.txt': 'Flask\nlxml\ncloudscraper\n' });
    const withBuildTools = suggest();
    expect(withBuildTools?.dockerfile).toContain('build-essential');
    expect(withBuildTools?.notes.join(' ')).toMatch(/compiler/i);

    rmSync(join(root, 'requirements.txt'));
    write({ 'app.py': '', 'requirements.txt': 'Flask\ngunicorn\n' });
    expect(suggest()?.dockerfile).not.toContain('build-essential');
  });

  it('detects FastAPI and points uvicorn at the right module', () => {
    write({ 'main.py': '', 'requirements.txt': 'fastapi\nuvicorn[standard]\n' });
    const result = suggest(9000);
    expect(result?.stack).toBe('python:fastapi');
    expect(result?.dockerfile).toContain('"uvicorn"');
    expect(result?.dockerfile).toContain('"main:app"');
    expect(result?.dockerfile).toContain('"9000"');
  });

  it('builds Node when there is a start script, and hedges on Next', () => {
    write({
      'package.json': JSON.stringify({ scripts: { build: 'tsc', start: 'node dist/index.js' }, dependencies: {} }),
      'package-lock.json': '{}',
    });
    expect(suggest(3000)?.stack).toBe('node:build');
    expect(suggest(3000)?.dockerfile).toContain('npm ci');
    expect(suggest(3000)?.dockerfile).toContain('ENV PORT=3000');

    write({ 'next.config.js': 'module.exports = {}' });
    expect(suggest(3000)?.stack).toBe('node:next');
  });

  it('serves a plain index.html with nginx', () => {
    write({ 'index.html': '<h1>hi</h1>' });
    const result = suggest(8080);
    expect(result?.stack).toBe('static');
    expect(result?.dockerfile).toContain('nginx:alpine');
    expect(result?.dockerfile).toContain('listen 8080');
  });

  it('says so when it recognises nothing instead of inventing an image', () => {
    write({ 'README.md': 'no idea' });
    expect(suggest()).toBeNull();
  });

  it('ignores vendor directories when reading the layout', () => {
    write({
      'index.html': '<h1>hi</h1>',
      'node_modules/left-pad/index.js': '',
      'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad' }),
    });
    const fingerprint = readFingerprint(root, { containerPort: 80, projectName: 'demo' });
    expect(fingerprint.files.some((file) => file.includes('node_modules'))).toBe(false);
    expect(suggest(80)?.stack).toBe('static');
  });
});

describe('applying an override to a clone', () => {
  it('writes the file when the repository has none', () => {
    expect(applyDockerfileOverride(root, 'Dockerfile', 'FROM nginx\n')).toBe('applied');
    expect(readFileSync(join(root, 'Dockerfile'), 'utf8')).toBe('FROM nginx\n');
  });

  it('never replaces the repository’s own Dockerfile', () => {
    write({ Dockerfile: 'FROM node:22\n' });
    expect(applyDockerfileOverride(root, 'Dockerfile', 'FROM python:3.12\n')).toBe('repo-wins');
    expect(readFileSync(join(root, 'Dockerfile'), 'utf8')).toBe('FROM node:22\n');
  });

  it('creates a nested path when the project points there', () => {
    expect(applyDockerfileOverride(root, 'docker/Dockerfile.prod', 'FROM rust\n')).toBe('applied');
    expect(readFileSync(join(root, 'docker/Dockerfile.prod'), 'utf8')).toBe('FROM rust\n');
  });

  it('refuses to write outside the clone', () => {
    expect(applyDockerfileOverride(root, '../escape/Dockerfile', 'FROM bad\n')).toBe('unsafe-path');
    expect(applyDockerfileOverride(root, '/etc/Dockerfile', 'FROM bad\n')).toBe('unsafe-path');
  });
});

describe('the stored Dockerfile, over HTTP', () => {
  let harness: AuthedApp;

  beforeEach(async () => {
    harness = await startApp();
    const now = Date.now();
    harness.db
      .prepare(
        `INSERT INTO projects (name, slug, repo_url, branch, dockerfile_path, container_port, health_path,
                               cpu_limit, memory_limit_mb, pids_limit, webhook_secret_encrypted,
                               github_token_encrypted, created_at, updated_at, status)
         VALUES ('df-demo', 'df-demo', 'https://github.com/o/r.git', 'main', 'Dockerfile', 8000, NULL,
                 0.5, 512, 256, NULL, NULL, ?, ?, 'idle')`,
      )
      .run(now, now);
  });

  afterEach(async () => {
    await harness.close();
  });

  it('saves, returns and clears a Dockerfile', async () => {
    const { cookie, csrfToken } = await harness.login();
    const headers = { cookie, 'x-csrf-token': csrfToken };

    const empty = await harness.app.inject({ method: 'GET', url: '/api/projects/1/dockerfile', headers: { cookie } });
    expect(empty.json()).toMatchObject({ override: null, dockerfilePath: 'Dockerfile' });

    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/projects/1/dockerfile',
      payload: { content: 'FROM python:3.12-slim\nCMD ["python", "app.py"]\n', source: 'generated' },
      headers,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ saved: true, override: { source: 'generated' } });

    const read = await harness.app.inject({ method: 'GET', url: '/api/projects/1/dockerfile', headers: { cookie } });
    const body = read.json() as { override: { content: string } };
    expect(body.override.content).toContain('python:3.12-slim');

    const cleared = await harness.app.inject({ method: 'DELETE', url: '/api/projects/1/dockerfile', headers });
    expect(cleared.json()).toMatchObject({ cleared: true });
  });

  it('rejects something that is not a Dockerfile', async () => {
    const { cookie, csrfToken } = await harness.login();
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/projects/1/dockerfile',
      payload: { content: 'just some text' },
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(response.statusCode).toBe(400);
  });
});
