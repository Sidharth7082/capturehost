/**
 * Why did this deployment fail?
 *
 * Deterministic on purpose. The pipeline already knows the stage it died in and the
 * error string it produced; this turns that into the sentence an operator needs,
 * without an LLM in the loop and without reading anything attacker-controlled.
 * An external agent can call the same rules through the agent API, but the rules
 * themselves are testable and free.
 */

export interface DeploymentLike {
  status: string;
  error: string | null;
  log: string | null;
}

export interface Diagnosis {
  stage: 'clone' | 'dockerfile' | 'build' | 'start' | 'health' | 'live' | 'other';
  summary: string;
  hints: string[];
  /** True when the fix is on the operator's side (repo, Dockerfile), not the platform. */
  actionable: boolean;
}

const RULES: Array<{
  id: string;
  stage: Diagnosis['stage'];
  match: RegExp;
  summary: string;
  hints: string[];
  actionable: boolean;
}> = [
  {
    id: 'branch-missing',
    stage: 'clone',
    match: /no branch "|Remote branch .* not found/i,
    summary: 'The repository has no such branch — most often it is completely empty.',
    hints: [
      'Push at least one commit to the branch the project uses.',
      'An empty repository has no default branch yet, so nothing can be cloned.',
    ],
    actionable: true,
  },
  {
    id: 'clone-403',
    stage: 'clone',
    match: /access token is missing|error: 403|Repository not found|Repository unavailable/i,
    summary: 'GitHub refused the clone: private without a token, renamed, deleted, or blocked.',
    hints: [
      'Private repository? Connect GitHub in Settings → Integrations, or set a per-project token.',
      'A DMCA takedown answers 403 as well — check the repository page in a browser.',
    ],
    actionable: true,
  },
  {
    id: 'clone-network',
    stage: 'clone',
    match: /Could not resolve host|Connection timed out|Network is unreachable|Could not reach GitHub/i,
    summary: 'This machine could not reach GitHub.',
    hints: ['Check the network, then deploy again.'],
    actionable: false,
  },
  {
    id: 'clone-too-large',
    stage: 'clone',
    match: /larger than the configured limit/i,
    summary: 'The repository is larger than the clone limit (200 MB by default).',
    hints: ['Do not commit build output, media or node_modules; or raise DEPLOY_MAX_CLONE_BYTES.'],
    actionable: true,
  },
  {
    id: 'dockerfile-missing',
    stage: 'dockerfile',
    match: /No Dockerfile at "(?<path>[^"]+)"/i,
    summary: 'The repository has no Dockerfile at the configured path.',
    hints: [
      'Add a Dockerfile at the repository root, or point the project at the one you have (project → Settings).',
      'The file must be a regular file, not a symlink.',
    ],
    actionable: true,
  },
  {
    id: 'build-failed',
    stage: 'build',
    match: /docker build|BuildKit|failed to solve|executor failed|No such file or directory: \/app/i,
    summary: 'The image did not build.',
    hints: [
      'Open the build log: the real error is the last line mentioning a Docker step, not the last line.',
      'A COPY that names a file the repository does not contain fails here.',
    ],
    actionable: true,
  },
  {
    id: 'restart-loop',
    stage: 'start',
    match: /restart loop|exited immediately|Container is in a restart loop/i,
    summary: 'The container starts and immediately exits.',
    hints: [
      'Run the image locally with the same environment to see the first error.',
      'A missing env var, a wrong CMD or a config file that is not in the image all look like this.',
    ],
    actionable: true,
  },
  {
    id: 'health-timeout',
    stage: 'health',
    match: /Health check did not pass|did not become healthy/i,
    summary: 'The container runs but nothing answers on the declared port.',
    hints: [
      'Bind 0.0.0.0, not 127.0.0.1 — inside a container localhost is only the container.',
      'The port your app listens on must equal the project container port.',
    ],
    actionable: true,
  },
  {
    id: 'port-busy',
    stage: 'start',
    match: /port is already allocated/i,
    summary: 'The host port was taken by something else mid-deploy.',
    hints: ['Usually self-correcting: the pipeline retries with the next free port.'],
    actionable: false,
  },
];

export function diagnoseDeployment(deployment: DeploymentLike): Diagnosis | null {
  if (deployment.status === 'live') return null;

  const haystack = `${deployment.error ?? ''}\n${deployment.log ?? ''}`;

  for (const rule of RULES) {
    if (!rule.match.test(haystack)) continue;

    const branch =
      /no branch "(?<branch>[^"]+)"/.exec(haystack)?.groups?.branch ??
      /Remote branch (?<branch>\S+) not found/i.exec(haystack)?.groups?.branch;
    const path = /No Dockerfile at "(?<path>[^"]+)"/.exec(haystack)?.groups?.path;

    return {
      stage: rule.stage,
      summary:
        rule.id === 'branch-missing' && branch
          ? `The repository has no branch "${branch}" — most often it is completely empty.`
          : rule.id === 'dockerfile-missing' && path
            ? `No Dockerfile at "${path}" in this repository.`
            : rule.summary,
      hints: rule.hints,
      actionable: rule.actionable,
    };
  }

  if (deployment.status === 'failed') {
    return {
      stage: 'other',
      summary: deployment.error ?? 'The deployment failed without a message.',
      hints: [
        'Open the build log — the pipeline keeps the last lines of every stage.',
        'If it is empty, the deployment was cancelled or the backend restarted mid-build.',
      ],
      actionable: false,
    };
  }

  return null;
}
