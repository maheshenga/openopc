import type { PublicBetaGateId } from './public-beta-evidence-v2';
import { PUBLIC_BETA_LANES, validatePublicBetaLanes } from './public-beta-lanes';

export type PublicBetaStageId =
  | 'evidence-foundation'
  | 'foundation-surfaces'
  | 'module-app-cli-lifecycle'
  | 'module-sandbox-ledger'
  | 'oci-runner-two-node'
  | 'evidence-closure';

export interface PublicBetaStage {
  readonly id: PublicBetaStageId;
  readonly plan: `docs/plans/${string}.md`;
  readonly dependsOn: readonly PublicBetaStageId[];
  readonly gates: readonly PublicBetaGateId[];
}

const EVIDENCE_PLAN =
  'docs/plans/2026-07-28-openopc-public-beta-evidence-operations-implementation.md' as const;

function stage(value: PublicBetaStage): Readonly<PublicBetaStage> {
  return Object.freeze({
    ...value,
    dependsOn: Object.freeze([...value.dependsOn]),
    gates: Object.freeze([...value.gates]),
  });
}

export const PUBLIC_BETA_STAGES: readonly Readonly<PublicBetaStage>[] = Object.freeze([
  stage({
    id: 'evidence-foundation',
    plan: EVIDENCE_PLAN,
    dependsOn: [],
    gates: [],
  }),
  stage({
    id: 'foundation-surfaces',
    plan: 'docs/plans/2026-07-28-openopc-public-beta-foundation-surfaces-implementation.md',
    dependsOn: ['evidence-foundation'],
    gates: ['B1', 'B2', 'B3', 'G11', 'B9'],
  }),
  stage({
    id: 'module-app-cli-lifecycle',
    plan: 'docs/plans/2026-07-28-openopc-module-app-cli-lifecycle-implementation.md',
    dependsOn: ['foundation-surfaces'],
    gates: ['G7', 'G8', 'G10', 'B4'],
  }),
  stage({
    id: 'module-sandbox-ledger',
    plan: 'docs/plans/2026-07-28-openopc-module-sandbox-ledger-implementation.md',
    dependsOn: ['module-app-cli-lifecycle'],
    gates: ['G9', 'B6'],
  }),
  stage({
    id: 'oci-runner-two-node',
    plan: 'docs/plans/2026-07-28-openopc-oci-runner-two-node-implementation.md',
    dependsOn: ['module-sandbox-ledger'],
    gates: ['G6', 'B5'],
  }),
  stage({
    id: 'evidence-closure',
    plan: EVIDENCE_PLAN,
    dependsOn: [
      'foundation-surfaces',
      'module-app-cli-lifecycle',
      'module-sandbox-ledger',
      'oci-runner-two-node',
    ],
    gates: ['G1', 'G2', 'G3', 'G4', 'G5', 'G12', 'B7', 'B8', 'B10'],
  }),
]);

const REQUIRED_GATES = Object.freeze([
  ...Array.from({ length: 12 }, (_, index) => `G${index + 1}` as PublicBetaGateId),
  ...Array.from({ length: 10 }, (_, index) => `B${index + 1}` as PublicBetaGateId),
]);

export function validatePublicBetaProgram(
  stages: readonly PublicBetaStage[],
): { valid: true } {
  const stageIds = stages.map((item) => item.id);
  if (new Set(stageIds).size !== stageIds.length) {
    throw new Error('PUBLIC_BETA_STAGE_ORDER_INVALID');
  }

  const positions = new Map(stageIds.map((id, index) => [id, index]));
  for (const [index, item] of stages.entries()) {
    if (
      item.dependsOn.some((dependency) => {
        const dependencyIndex = positions.get(dependency);
        return dependencyIndex === undefined || dependencyIndex >= index;
      })
    ) {
      throw new Error('PUBLIC_BETA_STAGE_ORDER_INVALID');
    }
  }

  const gates = stages.flatMap((item) => item.gates);
  const gateSet = new Set(gates);
  if (
    gates.length !== REQUIRED_GATES.length ||
    gateSet.size !== gates.length ||
    REQUIRED_GATES.some((gate) => !gateSet.has(gate))
  ) {
    throw new Error('PUBLIC_BETA_GATE_OWNERSHIP_INVALID');
  }

  validatePublicBetaLanes(PUBLIC_BETA_LANES, stages);

  return { valid: true };
}
