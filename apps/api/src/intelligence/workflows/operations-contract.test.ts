import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../../../..');

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('Intelligence workflow CI and operations contract', () => {
  test('closes API, frontend, and CLI path filters over shared Intelligence packages', () => {
    const ci = source('.github/workflows/ci.yml');

    expect(ci).toContain("- 'packages/intelligence-orchestration/**'");
    expect(ci).toContain("- 'packages/sdk/**'");
    expect(ci).toContain("- 'packages/api-contract/**'");
    expect(ci).toContain("- 'packages/intelligence-contracts/**'");
  });

  test('runs workflow acceptance plus required PostgreSQL restart and concurrency gates', () => {
    const packageTests = source('.github/workflows/package-tests.yml');
    const localCi = source('scripts/ci-local.sh');

    for (const workflow of [packageTests, localCi]) {
      expect(workflow).toContain('src/__tests__/e2e-intelligence-workflow.test.ts');
      expect(workflow).toContain('src/__tests__/e2e-intelligence-mcp.test.ts');
    }
    expect(packageTests).toContain(
      'RUN_INTEGRATION_TESTS=1 pnpm --filter kortix-api exec bun test src/intelligence/workflows/postgres.integration.test.ts',
    );
    expect(localCi).toContain('src/intelligence/workflows/postgres.integration.test.ts');
  });

  test('documents the complete flow, safe rollback, telemetry, and disabled production boundary', () => {
    const path = resolve(ROOT, 'docs/operations/intelligence-workflows.md');
    expect(existsSync(path)).toBe(true);
    const runbook = source('docs/operations/intelligence-workflows.md');
    const flows = source('tests/spec/end-to-end.md');

    expect(runbook).toContain('INTELLIGENCE_WORKFLOWS_ENABLED=false');
    expect(runbook).toContain('intelligence_workflow_scheduler_runs_total');
    expect(runbook).toContain('RUN_INTEGRATION_TESTS=1');
    expect(runbook).toContain('Rollback');
    expect(runbook).toContain('Redaction');
    expect(flows).toContain('`INTEL-7`');
    expect(flows).toContain('workflow_capabilities');
    expect(flows).toContain('workflow_start');
    expect(flows).toContain('workflow_status');
    expect(flows).toContain('Studio job');
    expect(flows).toContain('Review Center');
  });
});
