import type { DeploymentService } from '../src/services/deployments.js';
import type { DeploymentRow, ProjectRow } from '../src/db/projects.repo.js';

/**
 * Stand-in for the pipeline in route tests.
 *
 * The route layer only needs "queue this and give me an id", so the fake
 * records calls and returns a fake entry. Nothing here touches git or Docker.
 */
export interface FakeDeployments {
  service: DeploymentService;
  calls: {
    deploy: ProjectRow[];
    rollback: Array<{ project: ProjectRow; target: DeploymentRow }>;
    cancel: number[];
  };
  rollbackTarget: DeploymentRow | null;
}

export function createFakeDeployments(): FakeDeployments {
  const calls: FakeDeployments['calls'] = { deploy: [], rollback: [], cancel: [] };
  let nextId = 100;
  const fake: FakeDeployments = {
    calls,
    rollbackTarget: {
      id: 7,
      project_id: 1,
      commit_sha: 'f'.repeat(40),
      image_tag: 'capturehost/demo:fffffff',
      status: 'live',
      log: '',
      error: null,
      trigger: 'manual',
      duration_ms: 1000,
      rollback_of: null,
      container_id: 'c'.repeat(64),
      started_at: Date.now() - 1000,
      finished_at: Date.now(),
      created_at: Date.now() - 1000,
    },
    service: undefined as unknown as DeploymentService,
  };

  fake.service = {
    enqueueDeploy: (project: ProjectRow) => {
      calls.deploy.push(project);
      nextId += 1;
      return nextId;
    },
    enqueueRollback: (project: ProjectRow, target: DeploymentRow) => {
      calls.rollback.push({ project, target });
      nextId += 1;
      return nextId;
    },
    cancel: (deploymentId: number) => {
      calls.cancel.push(deploymentId);
    },
    latestRollbackTarget: () => fake.rollbackTarget,
    history: () => [],
    isBusy: () => false,
    queueLength: () => 0,
  } as unknown as DeploymentService;

  return fake;
}
