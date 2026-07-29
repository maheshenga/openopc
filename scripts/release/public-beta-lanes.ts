import type { PublicBetaGateId } from './public-beta-evidence-v2';
import type { PublicBetaStage, PublicBetaStageId } from './public-beta-program';

export interface PublicBetaLane {
  readonly gate: PublicBetaGateId;
  readonly lane: string;
  readonly ownerStage: PublicBetaStageId;
  readonly plan: `docs/plans/${string}.md`;
  readonly workflowJobId: string;
  readonly requiredServices: readonly string[];
  readonly requiredArtifacts: readonly string[];
  readonly maxAgeHours: number;
  readonly requiresVisibleBrowserEvidence: boolean;
  readonly requiresPackagedEvidence: boolean;
  readonly requiresRealDependencyEvidence: boolean;
  readonly requiresProductionApprovalEvidence: boolean;
  readonly dependsOn: readonly PublicBetaGateId[];
}

const PLANS = {
  evidence: 'docs/plans/2026-07-28-openopc-public-beta-evidence-operations-implementation.md',
  foundation:
    'docs/plans/2026-07-28-openopc-public-beta-foundation-surfaces-implementation.md',
  moduleApp: 'docs/plans/2026-07-28-openopc-module-app-cli-lifecycle-implementation.md',
  sandbox: 'docs/plans/2026-07-28-openopc-module-sandbox-ledger-implementation.md',
  oci: 'docs/plans/2026-07-28-openopc-oci-runner-two-node-implementation.md',
} as const;

const CANONICAL_LANE_NAMES: Readonly<Record<PublicBetaGateId, string>> = Object.freeze({
  G1: 'public-beta-g1-migration',
  G2: 'public-beta-g2-artifact-storage',
  G3: 'public-beta-g3-trust-pipeline',
  G4: 'public-beta-g4-malicious-fixtures',
  G5: 'public-beta-g5-wasi',
  G6: 'public-beta-g6-oci',
  G7: 'public-beta-g7-ui-capability',
  G8: 'public-beta-g8-tenant-authority',
  G9: 'public-beta-g9-sandbox-commerce',
  G10: 'public-beta-g10-release-lifecycle',
  G11: 'public-beta-g11-web-desktop',
  G12: 'public-beta-g12-upstream-compatibility',
  B1: 'public-beta-b1-registration',
  B2: 'public-beta-b2-web-independence',
  B3: 'public-beta-b3-admin-isolation',
  B4: 'public-beta-b4-module-workflow',
  B5: 'public-beta-b5-runtime-isolation',
  B6: 'public-beta-b6-sandbox-ledger',
  B7: 'public-beta-b7-backup-recovery',
  B8: 'public-beta-b8-telemetry-incident',
  B9: 'public-beta-b9-brand-upstream',
  B10: 'public-beta-b10-two-node-deployment',
});

function lane(
  gate: PublicBetaGateId,
  ownerStage: PublicBetaStageId,
  plan: PublicBetaLane['plan'],
  requiredServices: readonly string[],
  requiredArtifacts: readonly string[],
  options: {
    maxAgeHours?: number;
    visibleBrowser?: boolean;
    packaged?: boolean;
    dependsOn?: readonly PublicBetaGateId[];
  } = {},
): Readonly<PublicBetaLane> {
  const laneName = CANONICAL_LANE_NAMES[gate];
  return Object.freeze({
    gate,
    lane: laneName,
    ownerStage,
    plan,
    workflowJobId: laneName,
    requiredServices: Object.freeze([...requiredServices]),
    requiredArtifacts: Object.freeze([...requiredArtifacts]),
    maxAgeHours: options.maxAgeHours ?? 72,
    requiresVisibleBrowserEvidence: options.visibleBrowser ?? false,
    requiresPackagedEvidence: options.packaged ?? false,
    requiresRealDependencyEvidence: true,
    requiresProductionApprovalEvidence: false,
    dependsOn: Object.freeze([...(options.dependsOn ?? [])]),
  });
}

export const PUBLIC_BETA_LANES: readonly Readonly<PublicBetaLane>[] = Object.freeze([
  lane(
    'G1',
    'evidence-closure',
    PLANS.evidence,
    ['postgresql', 'backup-store'],
    [
      'migration-apply',
      'migration-idempotency',
      'migration-guards',
      'database-backup',
      'database-restore',
    ],
  ),
  lane(
    'G2',
    'evidence-closure',
    PLANS.evidence,
    ['private-object-storage', 'postgresql'],
    [
      'object-upload',
      'object-digest',
      'object-retention',
      'orphan-cleanup',
      'cross-tenant-denial',
    ],
  ),
  lane(
    'G3',
    'evidence-closure',
    PLANS.evidence,
    ['trust-worker', 'scanner-sandbox', 'provenance-signer'],
    [
      'secret-scan',
      'sbom',
      'vulnerability-scan',
      'static-analysis',
      'license-scan',
      'signed-provenance',
    ],
    { dependsOn: ['G2'] },
  ),
  lane(
    'G4',
    'evidence-closure',
    PLANS.evidence,
    ['trust-worker', 'scanner-sandbox'],
    ['malicious-fixture-matrix', 'scanner-crash-fail-closed'],
    { dependsOn: ['G3'] },
  ),
  lane(
    'G5',
    'evidence-closure',
    PLANS.evidence,
    ['wasi-runner', 'egress-proxy'],
    [
      'wasi-execution',
      'wasi-import-denial',
      'wasi-resource-limits',
      'wasi-cancellation',
      'wasi-egress',
      'wasi-determinism',
    ],
    { dependsOn: ['G3'] },
  ),
  lane(
    'G6',
    'oci-runner-two-node',
    PLANS.oci,
    ['oci-runner', 'rootless-containerd', 'runsc', 'egress-proxy'],
    ['oci-execution', 'oci-isolation', 'oci-escape-probes', 'oci-network-policy'],
    { dependsOn: ['G3'] },
  ),
  lane(
    'G7',
    'module-app-cli-lifecycle',
    PLANS.moduleApp,
    ['web', 'module-host', 'api'],
    ['browser-trace', 'browser-screenshots', 'capability-attack-report'],
    { visibleBrowser: true },
  ),
  lane(
    'G8',
    'module-app-cli-lifecycle',
    PLANS.moduleApp,
    ['api', 'postgresql'],
    ['authority-matrix', 'cross-tenant-denial', 'audit-records'],
    { visibleBrowser: true, dependsOn: ['B1', 'B3'] },
  ),
  lane(
    'G9',
    'module-sandbox-ledger',
    PLANS.sandbox,
    ['api', 'module-ledger-worker', 'postgresql'],
    ['commerce-scenario-matrix', 'ledger-reconciliation'],
    { dependsOn: ['B4'] },
  ),
  lane(
    'G10',
    'module-app-cli-lifecycle',
    PLANS.moduleApp,
    ['web', 'api', 'module-host'],
    ['release-lifecycle', 'canary', 'consent-diff', 'rollback-manifest'],
    { dependsOn: ['G7', 'G8'] },
  ),
  lane(
    'G11',
    'foundation-surfaces',
    PLANS.foundation,
    ['web', 'desktop', 'api'],
    ['responsive-browser-traces', 'desktop-package', 'desktop-smoke', 'console-log'],
    { visibleBrowser: true, packaged: true, dependsOn: ['B1', 'B2', 'B3'] },
  ),
  lane(
    'G12',
    'evidence-closure',
    PLANS.evidence,
    ['web', 'api', 'desktop', 'sdk'],
    [
      'upstream-rehearsal',
      'protected-file-diff',
      'core-smoke',
      'sdk-api-contracts',
      'disabled-state-audit',
    ],
    { dependsOn: ['B9'] },
  ),
  lane(
    'B1',
    'foundation-surfaces',
    PLANS.foundation,
    ['web', 'api', 'email-provider', 'turnstile'],
    [
      'registration-browser-trace',
      'abuse-control-report',
      'auth-parity-report',
      'consent-version-report',
      'privacy-request-report',
    ],
    { visibleBrowser: true },
  ),
  lane(
    'B2',
    'foundation-surfaces',
    PLANS.foundation,
    ['web', 'api'],
    ['remote-workflow-browser-trace', 'desktop-independence-report'],
    { visibleBrowser: true, dependsOn: ['B1'] },
  ),
  lane(
    'B3',
    'foundation-surfaces',
    PLANS.foundation,
    ['admin', 'api'],
    [
      'admin-build',
      'admin-route-isolation',
      'admin-iam-report',
      'admin-audit',
      'admin-deployment-smoke',
    ],
    { visibleBrowser: true, dependsOn: ['B1'] },
  ),
  lane(
    'B4',
    'module-app-cli-lifecycle',
    PLANS.moduleApp,
    ['web', 'module-host', 'api', 'trust-worker'],
    ['module-workflow-browser-trace', 'cli-sdk-validation', 'trust-review', 'module-lifecycle'],
    { visibleBrowser: true, dependsOn: ['G7', 'G8', 'G10'] },
  ),
  lane(
    'B5',
    'oci-runner-two-node',
    PLANS.oci,
    ['wasi-runner', 'oci-runner', 'egress-proxy'],
    [
      'runtime-authority',
      'runtime-resource-limits',
      'runtime-egress',
      'runtime-cancellation',
      'runtime-escape-denial',
    ],
    { dependsOn: ['G5', 'G6'] },
  ),
  lane(
    'B6',
    'module-sandbox-ledger',
    PLANS.sandbox,
    ['api', 'module-ledger-worker', 'postgresql'],
    [
      'usage-acceptance',
      'worker-idempotency',
      'balanced-postings',
      'refund-dispute',
      'versioned-splits',
      'statements',
    ],
    { dependsOn: ['G9'] },
  ),
  lane(
    'B7',
    'evidence-closure',
    PLANS.evidence,
    ['postgresql', 'private-object-storage', 'backup-store'],
    ['pitr-restore', 'object-restore', 'rpo-rto', 'restore-consistency', 'post-restore-smoke'],
    { maxAgeHours: 168, dependsOn: ['G1', 'G2'] },
  ),
  lane(
    'B8',
    'evidence-closure',
    PLANS.evidence,
    ['otel-collector', 'api', 'workers', 'runners'],
    [
      'correlated-trace',
      'slo-dashboard',
      'alert-results',
      'dead-letter-recovery',
      'failure-drill',
    ],
    { dependsOn: ['B5', 'B6'] },
  ),
  lane(
    'B9',
    'foundation-surfaces',
    PLANS.foundation,
    ['web', 'admin', 'desktop'],
    ['visible-brand-audit', 'compatibility-id-audit', 'protected-file-diff', 'upstream-rehearsal'],
    { visibleBrowser: true, packaged: true, dependsOn: ['G11'] },
  ),
  lane(
    'B10',
    'evidence-closure',
    PLANS.evidence,
    ['nginx', 'control-node', 'execution-node', 'web', 'admin', 'api'],
    [
      'deployment-topology',
      'public-exposure-scan',
      'tls-realtime-smoke',
      'private-dependency-scan',
      'regional-prerequisites',
      'artifact-commit-manifest',
    ],
    { maxAgeHours: 24, dependsOn: ['B7', 'B8', 'G12'] },
  ),
]);

export const PUBLIC_BETA_LANES_BY_GATE: Readonly<
  Record<PublicBetaGateId, Readonly<PublicBetaLane>>
> = Object.freeze(
  Object.fromEntries(PUBLIC_BETA_LANES.map((entry) => [entry.gate, entry])) as Record<
    PublicBetaGateId,
    Readonly<PublicBetaLane>
  >,
);

function nonEmptyUniqueStrings(values: readonly string[]): boolean {
  return (
    values.length > 0 &&
    values.every((value) => typeof value === 'string' && value.trim() === value && value.length > 0) &&
    new Set(values).size === values.length
  );
}

export function validatePublicBetaLanes(
  lanes: readonly PublicBetaLane[],
  stages: readonly PublicBetaStage[],
): { valid: true } {
  const requiredGates = Object.keys(CANONICAL_LANE_NAMES) as PublicBetaGateId[];
  const gates = lanes.map((entry) => entry.gate);
  const laneNames = lanes.map((entry) => entry.lane);
  const jobIds = lanes.map((entry) => entry.workflowJobId);
  if (
    lanes.length !== requiredGates.length ||
    new Set(gates).size !== lanes.length ||
    new Set(laneNames).size !== lanes.length ||
    new Set(jobIds).size !== lanes.length ||
    requiredGates.some((gate) => !gates.includes(gate))
  ) {
    throw new Error('PUBLIC_BETA_LANE_IDENTITY_INVALID');
  }

  const byGate = new Map(lanes.map((entry) => [entry.gate, entry]));
  for (const entry of lanes) {
    const expectedAge = entry.gate === 'B7' ? 168 : entry.gate === 'B10' ? 24 : 72;
    if (
      entry.lane !== CANONICAL_LANE_NAMES[entry.gate] ||
      entry.workflowJobId !== entry.lane ||
      entry.maxAgeHours !== expectedAge ||
      !nonEmptyUniqueStrings(entry.requiredServices) ||
      !nonEmptyUniqueStrings(entry.requiredArtifacts) ||
      typeof entry.requiresVisibleBrowserEvidence !== 'boolean' ||
      typeof entry.requiresPackagedEvidence !== 'boolean' ||
      entry.requiresRealDependencyEvidence !== true ||
      entry.requiresProductionApprovalEvidence !== false ||
      new Set(entry.dependsOn).size !== entry.dependsOn.length ||
      entry.dependsOn.some((dependency) => !byGate.has(dependency) || dependency === entry.gate)
    ) {
      throw new Error('PUBLIC_BETA_LANE_METADATA_INVALID');
    }
  }

  const stageByGate = new Map<PublicBetaGateId, PublicBetaStage>();
  for (const stage of stages) {
    for (const gate of stage.gates) stageByGate.set(gate, stage);
  }
  for (const entry of lanes) {
    const owner = stageByGate.get(entry.gate);
    if (owner?.id !== entry.ownerStage || owner.plan !== entry.plan) {
      throw new Error('PUBLIC_BETA_LANE_OWNERSHIP_INVALID');
    }
  }

  const visiting = new Set<PublicBetaGateId>();
  const visited = new Set<PublicBetaGateId>();
  const visit = (gate: PublicBetaGateId): void => {
    if (visiting.has(gate)) throw new Error('PUBLIC_BETA_LANE_DEPENDENCY_CYCLE');
    if (visited.has(gate)) return;
    visiting.add(gate);
    for (const dependency of byGate.get(gate)!.dependsOn) visit(dependency);
    visiting.delete(gate);
    visited.add(gate);
  };
  for (const gate of requiredGates) visit(gate);

  return { valid: true };
}
