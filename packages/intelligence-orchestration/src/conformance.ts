import { describe, expect, test } from 'bun:test';
import type { WorkflowRun } from '@kortix/intelligence-contracts';
import type { WorkflowPort } from './contracts';

export type WorkflowPortConformanceFixture = {
  createPort: () => WorkflowPort | Promise<WorkflowPort>;
  run: () => WorkflowRun;
};

export function runWorkflowPortConformance(
  name: string,
  fixture: WorkflowPortConformanceFixture,
): void {
  describe(`${name} WorkflowPort conformance`, () => {
    test('replays one project-scoped run idempotently', async () => {
      const port = await fixture.createPort();
      const run = fixture.run();

      const created = await port.startRun({ run });
      const replayed = await port.startRun({ run });

      expect(created).toEqual({ run, created: true });
      expect(replayed).toEqual({ run, created: false });
    });
  });
}
