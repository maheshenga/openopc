import type { PublicBetaGateId } from './public-beta-evidence-v2';
import type { PublicBetaLane } from './public-beta-lanes';
import type { OpenOpcRestrictedPublicBetaProfileV1 } from './public-beta-release-profile';

export type OpenOpcRestrictedPublicBetaGateId =
  OpenOpcRestrictedPublicBetaProfileV1['requiredGates'][number];

const PLANS = {
  evidence: 'docs/plans/2026-07-28-openopc-public-beta-evidence-operations-implementation.md',
  foundation:
    'docs/plans/2026-07-28-openopc-public-beta-foundation-surfaces-implementation.md',
  moduleLifecycle: 'docs/plans/2026-07-28-openopc-module-app-cli-lifecycle-implementation.md',
  topology: 'docs/plans/2026-07-28-openopc-oci-runner-two-node-implementation.md',
} as const;

function lane(
  gate: OpenOpcRestrictedPublicBetaGateId,
  laneName: string,
  ownerStage: PublicBetaLane['ownerStage'],
  plan: PublicBetaLane['plan'],
  requiredServices: readonly string[],
  requiredArtifacts: readonly string[],
  options: {
    maxAgeHours?: number;
    visibleBrowser?: boolean;
    packaged?: boolean;
    dependsOn?: readonly OpenOpcRestrictedPublicBetaGateId[];
  } = {},
): Readonly<PublicBetaLane> {
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
    dependsOn: Object.freeze([...(options.dependsOn ?? [])]) as readonly PublicBetaGateId[],
  });
}

export const OPENOPC_RESTRICTED_PUBLIC_BETA_LANES: readonly Readonly<PublicBetaLane>[] =
  Object.freeze([
    lane(
      'G1',
      'public-beta-g1-migration',
      'evidence-closure',
      PLANS.evidence,
      ['postgresql', 'backup-store'],
      ['migration-apply', 'migration-idempotency', 'migration-guards', 'database-backup', 'database-restore'],
    ),
    lane(
      'G2',
      'public-beta-g2-artifact-storage',
      'evidence-closure',
      PLANS.evidence,
      ['private-object-storage', 'postgresql'],
      ['object-upload', 'object-digest', 'object-retention', 'orphan-cleanup', 'cross-tenant-denial'],
    ),
    lane(
      'G3',
      'public-beta-g3-trust-pipeline',
      'evidence-closure',
      PLANS.evidence,
      ['developer-trust-worker', 'scanner-sandbox', 'provenance-signer'],
      ['secret-scan', 'sbom', 'vulnerability-scan', 'static-analysis', 'license-scan', 'signed-provenance'],
      { dependsOn: ['G2'] },
    ),
    lane(
      'G4',
      'public-beta-g4-malicious-fixtures',
      'evidence-closure',
      PLANS.evidence,
      ['developer-trust-worker', 'scanner-sandbox'],
      ['malicious-fixture-matrix', 'scanner-crash-fail-closed'],
      { dependsOn: ['G3'] },
    ),
    lane(
      'G5',
      'public-beta-g5-wasi',
      'evidence-closure',
      PLANS.evidence,
      ['wasi-runner', 'egress-proxy'],
      ['wasi-execution', 'wasi-import-denial', 'wasi-resource-limits', 'wasi-cancellation', 'wasi-egress', 'wasi-determinism'],
      { dependsOn: ['G3'] },
    ),
    lane(
      'G8',
      'public-beta-g8-tenant-authority',
      'module-app-cli-lifecycle',
      PLANS.moduleLifecycle,
      ['api', 'postgresql'],
      ['authority-matrix', 'cross-tenant-denial', 'audit-records'],
      { visibleBrowser: true, dependsOn: ['B1', 'B3'] },
    ),
    lane(
      'G10',
      'public-beta-g10-release-lifecycle',
      'module-app-cli-lifecycle',
      PLANS.moduleLifecycle,
      ['web', 'api', 'wasi-runner'],
      ['reviewed-wasi-install', 'reviewed-wasi-pause-resume', 'reviewed-wasi-revoke', 'consent-diff', 'rollback-manifest'],
      { dependsOn: ['G5', 'G8'] },
    ),
    lane(
      'G11',
      'public-beta-g11-web-desktop',
      'foundation-surfaces',
      PLANS.foundation,
      ['web', 'desktop', 'api'],
      ['responsive-browser-traces', 'desktop-package', 'desktop-smoke', 'console-log'],
      { visibleBrowser: true, packaged: true, dependsOn: ['B1', 'B2', 'B3'] },
    ),
    lane(
      'G12',
      'public-beta-g12-upstream-compatibility',
      'evidence-closure',
      PLANS.evidence,
      ['web', 'api', 'desktop', 'sdk'],
      ['upstream-rehearsal', 'protected-file-diff', 'core-smoke', 'sdk-api-contracts', 'disabled-state-audit'],
      { dependsOn: ['B9'] },
    ),
    lane(
      'B1',
      'public-beta-b1-registration',
      'foundation-surfaces',
      PLANS.foundation,
      ['web', 'api', 'email-provider', 'turnstile'],
      ['registration-browser-trace', 'abuse-control-report', 'auth-parity-report', 'consent-version-report', 'privacy-request-report'],
      { visibleBrowser: true },
    ),
    lane(
      'B2',
      'public-beta-b2-web-independence',
      'foundation-surfaces',
      PLANS.foundation,
      ['web', 'api'],
      ['remote-workflow-browser-trace', 'desktop-independence-report'],
      { visibleBrowser: true, dependsOn: ['B1'] },
    ),
    lane(
      'B3',
      'public-beta-b3-admin-isolation',
      'foundation-surfaces',
      PLANS.foundation,
      ['admin', 'api'],
      ['admin-build', 'admin-route-isolation', 'admin-iam-report', 'admin-audit', 'admin-deployment-smoke'],
      { visibleBrowser: true, dependsOn: ['B1'] },
    ),
    lane(
      'B4',
      'public-beta-b4-module-workflow',
      'module-app-cli-lifecycle',
      PLANS.moduleLifecycle,
      ['web', 'api', 'developer-trust-worker', 'wasi-runner'],
      ['developer-application', 'trust-review', 'wasi-publication', 'wasi-installation', 'wasi-revocation', 'wasi-rollback'],
      { visibleBrowser: true, dependsOn: ['G3', 'G4', 'G5', 'G8', 'G10'] },
    ),
    lane(
      'B5',
      'public-beta-b5-runtime-isolation',
      'oci-runner-two-node',
      PLANS.topology,
      ['wasi-runner', 'egress-proxy'],
      ['runtime-authority', 'runtime-resource-limits', 'runtime-egress', 'runtime-cancellation', 'runtime-escape-denial'],
      { dependsOn: ['G5'] },
    ),
    lane(
      'B7',
      'public-beta-b7-backup-recovery',
      'evidence-closure',
      PLANS.evidence,
      ['postgresql', 'private-object-storage', 'backup-store'],
      ['pitr-restore', 'object-restore', 'rpo-rto', 'restore-consistency', 'post-restore-smoke'],
      { maxAgeHours: 168, dependsOn: ['G1', 'G2'] },
    ),
    lane(
      'B8',
      'public-beta-b8-telemetry-incident',
      'evidence-closure',
      PLANS.evidence,
      ['api', 'studio-worker', 'developer-trust-worker', 'wasi-runner', 'control-node', 'execution-node'],
      ['correlated-trace', 'minimum-alerts', 'dead-letter-recovery', 'failure-drill'],
      { dependsOn: ['B5'] },
    ),
    lane(
      'B9',
      'public-beta-b9-brand-upstream',
      'foundation-surfaces',
      PLANS.foundation,
      ['web', 'admin', 'desktop'],
      ['visible-brand-audit', 'compatibility-id-audit', 'protected-file-diff', 'upstream-rehearsal'],
      { visibleBrowser: true, packaged: true, dependsOn: ['G11'] },
    ),
    lane(
      'B10',
      'public-beta-b10-two-node-deployment',
      'evidence-closure',
      PLANS.evidence,
      ['nginx', 'control-node', 'execution-node', 'web', 'admin', 'api'],
      ['deployment-topology', 'public-exposure-scan', 'tls-realtime-smoke', 'private-dependency-scan', 'regional-prerequisites', 'artifact-commit-manifest'],
      { maxAgeHours: 24, dependsOn: ['B7', 'B8', 'G12'] },
    ),
  ]);

export const OPENOPC_RESTRICTED_PUBLIC_BETA_LANES_BY_GATE: Readonly<
  Record<OpenOpcRestrictedPublicBetaGateId, Readonly<PublicBetaLane>>
> = Object.freeze(
  Object.fromEntries(
    OPENOPC_RESTRICTED_PUBLIC_BETA_LANES.map((entry) => [entry.gate, entry]),
  ) as Record<OpenOpcRestrictedPublicBetaGateId, Readonly<PublicBetaLane>>,
);

const EXPECTED_DEPENDENCIES: Readonly<
  Record<OpenOpcRestrictedPublicBetaGateId, readonly OpenOpcRestrictedPublicBetaGateId[]>
> = Object.freeze({
  G1: Object.freeze([]),
  G2: Object.freeze([]),
  G3: Object.freeze(['G2']),
  G4: Object.freeze(['G3']),
  G5: Object.freeze(['G3']),
  G8: Object.freeze(['B1', 'B3']),
  G10: Object.freeze(['G5', 'G8']),
  G11: Object.freeze(['B1', 'B2', 'B3']),
  G12: Object.freeze(['B9']),
  B1: Object.freeze([]),
  B2: Object.freeze(['B1']),
  B3: Object.freeze(['B1']),
  B4: Object.freeze(['G3', 'G4', 'G5', 'G8', 'G10']),
  B5: Object.freeze(['G5']),
  B7: Object.freeze(['G1', 'G2']),
  B8: Object.freeze(['B5']),
  B9: Object.freeze(['G11']),
  B10: Object.freeze(['B7', 'B8', 'G12']),
});

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nonEmptyUniqueStrings(values: readonly string[]): boolean {
  return (
    values.length > 0 &&
    values.every((value) => value.length > 0 && value.trim() === value) &&
    new Set(values).size === values.length
  );
}

export function validateOpenOpcRestrictedPublicBetaLanes(
  lanes: readonly Readonly<PublicBetaLane>[] = OPENOPC_RESTRICTED_PUBLIC_BETA_LANES,
): { valid: true } {
  const gates = Object.keys(EXPECTED_DEPENDENCIES) as OpenOpcRestrictedPublicBetaGateId[];
  if (
    lanes.length !== gates.length ||
    lanes.some((entry, index) => entry.gate !== gates[index]) ||
    new Set(lanes.map((entry) => entry.lane)).size !== lanes.length ||
    new Set(lanes.map((entry) => entry.workflowJobId)).size !== lanes.length
  ) {
    throw new Error('OPENOPC_RESTRICTED_PUBLIC_BETA_LANE_IDENTITY_INVALID');
  }
  const byGate = new Map(lanes.map((entry) => [entry.gate, entry]));
  const forbiddenRequirements = new Set([
    'module-host',
    'oci-runner',
    'module-ledger-worker',
    'automation-browser-worker',
  ]);
  for (const entry of lanes) {
    const gate = entry.gate as OpenOpcRestrictedPublicBetaGateId;
    const canonicalLane = OPENOPC_RESTRICTED_PUBLIC_BETA_LANES_BY_GATE[gate];
    const expectedAge = gate === 'B7' ? 168 : gate === 'B10' ? 24 : 72;
    if (
      entry.lane !== canonicalLane.lane ||
      entry.workflowJobId !== entry.lane ||
      entry.ownerStage !== canonicalLane.ownerStage ||
      entry.plan !== canonicalLane.plan ||
      entry.maxAgeHours !== expectedAge ||
      !nonEmptyUniqueStrings(entry.requiredServices) ||
      !nonEmptyUniqueStrings(entry.requiredArtifacts) ||
      !exactStrings(entry.requiredServices, canonicalLane.requiredServices) ||
      !exactStrings(entry.requiredArtifacts, canonicalLane.requiredArtifacts) ||
      [...entry.requiredServices, ...entry.requiredArtifacts].some((value) =>
        [...forbiddenRequirements].some((forbidden) => value.includes(forbidden)),
      ) ||
      entry.requiresVisibleBrowserEvidence !== canonicalLane.requiresVisibleBrowserEvidence ||
      entry.requiresPackagedEvidence !== canonicalLane.requiresPackagedEvidence ||
      entry.requiresRealDependencyEvidence !== canonicalLane.requiresRealDependencyEvidence ||
      entry.requiresProductionApprovalEvidence !==
        canonicalLane.requiresProductionApprovalEvidence ||
      !exactStrings(entry.dependsOn, EXPECTED_DEPENDENCIES[gate])
    ) {
      throw new Error('OPENOPC_RESTRICTED_PUBLIC_BETA_LANE_METADATA_INVALID');
    }
  }
  const visiting = new Set<PublicBetaGateId>();
  const visited = new Set<PublicBetaGateId>();
  const visit = (gate: PublicBetaGateId): void => {
    if (visiting.has(gate)) throw new Error('OPENOPC_RESTRICTED_PUBLIC_BETA_LANE_CYCLE');
    if (visited.has(gate)) return;
    visiting.add(gate);
    const entry = byGate.get(gate);
    if (entry === undefined) throw new Error('OPENOPC_RESTRICTED_PUBLIC_BETA_LANE_METADATA_INVALID');
    for (const dependency of entry.dependsOn) visit(dependency);
    visiting.delete(gate);
    visited.add(gate);
  };
  for (const gate of gates) visit(gate);
  return { valid: true };
}
