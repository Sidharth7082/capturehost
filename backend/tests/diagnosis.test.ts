import { describe, expect, it } from 'vitest';
import { diagnoseDeployment } from '../src/services/diagnosis.js';

/**
 * The diagnosis rules.
 *
 * These are the messages an operator reads instead of a wall of build output, so
 * each rule is pinned to the exact string the pipeline actually produces. They are
 * also what the agent API returns, which is why they are tested here rather than
 * inside a route.
 */

function d(error: string | null, log = '', status = 'failed') {
  return diagnoseDeployment({ status, error, log });
}

describe('diagnoseDeployment', () => {
  it('says nothing about a deployment that worked', () => {
    expect(diagnoseDeployment({ status: 'live', error: null, log: 'ok' })).toBeNull();
  });

  it('names an empty repository as a missing branch, not as an auth problem', () => {
    const result = d('This repository has no branch "main" — it may be empty, or the branch is named differently');
    expect(result?.stage).toBe('clone');
    expect(result?.summary).toContain('no branch "main"');
    expect(result?.actionable).toBe(true);
  });

  it('reads the branch out of raw git output too', () => {
    expect(d('Clone failed', "fatal: Remote branch develop not found in upstream origin")?.summary).toContain(
      'no branch "develop"',
    );
  });

  it('separates a takedown or private repo from a network failure', () => {
    const forbidden = d('Repository not found, or the access token is missing/invalid for it');
    expect(forbidden?.stage).toBe('clone');
    expect(forbidden?.hints.join(' ')).toMatch(/DMCA|private/i);

    const offline = d('Could not reach GitHub from this machine — check the network');
    expect(offline?.stage).toBe('clone');
    expect(offline?.actionable).toBe(false);
  });

  it('names the Dockerfile path when it is missing', () => {
    const result = d('No Dockerfile at "docker/Dockerfile.prod" in this repository');
    expect(result?.stage).toBe('dockerfile');
    expect(result?.summary).toContain('docker/Dockerfile.prod');
  });

  it('points at the bind address when the health check never passes', () => {
    const result = d('Health check did not pass within 30s');
    expect(result?.stage).toBe('health');
    expect(result?.hints.join(' ')).toContain('0.0.0.0');
  });

  it('recognises a restart loop and a build failure', () => {
    expect(d('Container is in a restart loop')?.stage).toBe('start');
    expect(d('Build failed', 'executor failed running [/bin/sh -c npm ci]')?.stage).toBe('build');
  });

  it('falls back to the error text rather than inventing a cause', () => {
    const result = d('something nobody has seen before');
    expect(result?.stage).toBe('other');
    expect(result?.summary).toBe('something nobody has seen before');
    expect(result?.actionable).toBe(false);
  });

  it('stays quiet about a cancellation — that is not a problem to solve', () => {
    expect(diagnoseDeployment({ status: 'cancelled', error: null, log: 'Cancelled' })).toBeNull();
  });
});
