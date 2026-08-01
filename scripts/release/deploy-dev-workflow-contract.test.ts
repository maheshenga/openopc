import { expect, test } from 'bun:test';

type WorkflowStep = {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
};

type WorkflowJob = {
  if?: string;
  steps: WorkflowStep[];
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

const WORKFLOW = '.github/workflows/deploy-dev.yml';
const REMOTE_DEPLOY_GUARD = "vars.OPENOPC_DEV_SERVER_DEPLOY_ENABLED == 'true'";

async function parseWorkflow(): Promise<Workflow> {
  return Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as Workflow;
}

function job(workflow: Workflow, id: string): WorkflowJob {
  const value = workflow.jobs[id];
  if (!value) throw new Error(`Missing workflow job: ${id}`);
  return value;
}

function namedStep(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const value = workflowJob.steps.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing workflow step: ${name}`);
  return value;
}

function actionStep(workflowJob: WorkflowJob, action: string): WorkflowStep {
  const value = workflowJob.steps.find((candidate) => candidate.uses === action);
  if (!value) throw new Error(`Missing workflow action: ${action}`);
  return value;
}

function assertJobGuard(workflow: Workflow, id: string, pathGuard: string): void {
  const condition = job(workflow, id).if;
  expect(condition, id).toBe(`${pathGuard} && ${REMOTE_DEPLOY_GUARD}`);
}

test('Deploy Dev only runs inherited server infrastructure when explicitly enabled', async () => {
  const workflow = await parseWorkflow();
  for (const id of ['build-api', 'tag-api', 'supply-chain', 'migrate-db', 'deploy-api-ecs', 'deploy-api']) {
    assertJobGuard(workflow, id, "needs.detect-changes.outputs.api == 'true'");
  }
  for (const id of ['build-gateway', 'tag-gateway', 'deploy-gateway']) {
    assertJobGuard(workflow, id, "needs.detect-changes.outputs.gateway == 'true'");
  }
});

test('Deploy Dev keeps the frontend standalone build independent while gating image publication', async () => {
  const workflow = await parseWorkflow();
  const frontend = job(workflow, 'build-frontend');
  expect(frontend.if).toBe("needs.detect-changes.outputs.frontend == 'true'");
  expect(namedStep(frontend, 'Build frontend standalone output').if).toBeUndefined();

  for (const name of [
    'Set up QEMU',
    'Set up Docker Buildx',
    'Build and push (amd64 + arm64)',
    'Retag :dev-latest → :dev-<sha8>',
  ]) {
    expect(namedStep(frontend, name).if, name).toBe(REMOTE_DEPLOY_GUARD);
  }
  expect(actionStep(frontend, 'docker/login-action@v3').if, 'Docker login').toBe(REMOTE_DEPLOY_GUARD);
});

test('Deploy Dev keeps CLI build and dev-latest publication independent of remote deployment', async () => {
  const workflow = await parseWorkflow();
  expect(job(workflow, 'build-cli').if).toBe("needs.detect-changes.outputs.cli == 'true'");
  expect(job(workflow, 'publish-dev-release').if).toBe(
    "needs.detect-changes.outputs.cli == 'true' && needs.build-cli.result == 'success'",
  );
});

test('Deploy Dev summary identifies the default non-deployment and explicit opt-in', async () => {
  const workflow = await parseWorkflow();
  const summary = namedStep(job(workflow, 'detect-changes'), 'Summary').run;
  expect(summary).toContain(
    '  if [ "${{ vars.OPENOPC_DEV_SERVER_DEPLOY_ENABLED }}" = "true" ]; then\n'
      + '    echo "- Remote backend: deployment enabled (OPENOPC_DEV_SERVER_DEPLOY_ENABLED=true)"\n'
      + '  else\n'
      + '    echo "- Remote backend: not deployed (set OPENOPC_DEV_SERVER_DEPLOY_ENABLED=true to opt in)"\n'
      + '  fi',
  );
});
