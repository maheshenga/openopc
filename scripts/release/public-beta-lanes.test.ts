import { describe, expect, test } from 'bun:test';
import { PUBLIC_BETA_STAGES, validatePublicBetaProgram } from './public-beta-program';
import {
  PUBLIC_BETA_LANES,
  PUBLIC_BETA_LANES_BY_GATE,
  type PublicBetaLane,
  validatePublicBetaLanes,
} from './public-beta-lanes';

type Gate =
  | `G${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`
  | `B${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;

const PLANS = {
  evidence: 'docs/plans/2026-07-28-openopc-public-beta-evidence-operations-implementation.md',
  foundation:
    'docs/plans/2026-07-28-openopc-public-beta-foundation-surfaces-implementation.md',
  moduleApp: 'docs/plans/2026-07-28-openopc-module-app-cli-lifecycle-implementation.md',
  sandbox: 'docs/plans/2026-07-28-openopc-module-sandbox-ledger-implementation.md',
  oci: 'docs/plans/2026-07-28-openopc-oci-runner-two-node-implementation.md',
} as const;

function expectedLane(
  gate: Gate,
  lane: string,
  ownerStage: PublicBetaLane['ownerStage'],
  plan: PublicBetaLane['plan'],
  requiredServices: readonly string[],
  requiredArtifacts: readonly string[],
  options: {
    maxAgeHours?: number;
    visibleBrowser?: boolean;
    packaged?: boolean;
    dependsOn?: readonly Gate[];
  } = {},
): PublicBetaLane {
  return {
    gate,
    lane,
    ownerStage,
    plan,
    workflowJobId: lane,
    requiredServices,
    requiredArtifacts,
    maxAgeHours: options.maxAgeHours ?? 72,
    requiresVisibleBrowserEvidence: options.visibleBrowser ?? false,
    requiresPackagedEvidence: options.packaged ?? false,
    requiresRealDependencyEvidence: true,
    requiresProductionApprovalEvidence: false,
    dependsOn: options.dependsOn ?? [],
  };
}

const EXPECTED_LANES: readonly PublicBetaLane[] = [
  expectedLane(
    'G1',
    'public-beta-g1-migration',
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
  expectedLane(
    'G2',
    'public-beta-g2-artifact-storage',
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
  expectedLane(
    'G3',
    'public-beta-g3-trust-pipeline',
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
  expectedLane(
    'G4',
    'public-beta-g4-malicious-fixtures',
    'evidence-closure',
    PLANS.evidence,
    ['trust-worker', 'scanner-sandbox'],
    ['malicious-fixture-matrix', 'scanner-crash-fail-closed'],
    { dependsOn: ['G3'] },
  ),
  expectedLane(
    'G5',
    'public-beta-g5-wasi',
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
  expectedLane(
    'G6',
    'public-beta-g6-oci',
    'oci-runner-two-node',
    PLANS.oci,
    ['oci-runner', 'rootless-containerd', 'runsc', 'egress-proxy'],
    ['oci-execution', 'oci-isolation', 'oci-escape-probes', 'oci-network-policy'],
    { dependsOn: ['G3'] },
  ),
  expectedLane(
    'G7',
    'public-beta-g7-ui-capability',
    'module-app-cli-lifecycle',
    PLANS.moduleApp,
    ['web', 'module-host', 'api'],
    ['browser-trace', 'browser-screenshots', 'capability-attack-report'],
    { visibleBrowser: true },
  ),
  expectedLane(
    'G8',
    'public-beta-g8-tenant-authority',
    'module-app-cli-lifecycle',
    PLANS.moduleApp,
    ['api', 'postgresql'],
    ['authority-matrix', 'cross-tenant-denial', 'audit-records'],
    { visibleBrowser: true, dependsOn: ['B1', 'B3'] },
  ),
  expectedLane(
    'G9',
    'public-beta-g9-sandbox-commerce',
    'module-sandbox-ledger',
    PLANS.sandbox,
    ['api', 'module-ledger-worker', 'postgresql'],
    ['commerce-scenario-matrix', 'ledger-reconciliation'],
    { dependsOn: ['B4'] },
  ),
  expectedLane(
    'G10',
    'public-beta-g10-release-lifecycle',
    'module-app-cli-lifecycle',
    PLANS.moduleApp,
    ['web', 'api', 'module-host'],
    ['release-lifecycle', 'canary', 'consent-diff', 'rollback-manifest'],
    { dependsOn: ['G7', 'G8'] },
  ),
  expectedLane(
    'G11',
    'public-beta-g11-web-desktop',
    'foundation-surfaces',
    PLANS.foundation,
    ['web', 'desktop', 'api'],
    ['responsive-browser-traces', 'desktop-package', 'desktop-smoke', 'console-log'],
    { visibleBrowser: true, packaged: true, dependsOn: ['B1', 'B2', 'B3'] },
  ),
  expectedLane(
    'G12',
    'public-beta-g12-upstream-compatibility',
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
  expectedLane(
    'B1',
    'public-beta-b1-registration',
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
  expectedLane(
    'B2',
    'public-beta-b2-web-independence',
    'foundation-surfaces',
    PLANS.foundation,
    ['web', 'api'],
    ['remote-workflow-browser-trace', 'desktop-independence-report'],
    { visibleBrowser: true, dependsOn: ['B1'] },
  ),
  expectedLane(
    'B3',
    'public-beta-b3-admin-isolation',
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
  expectedLane(
    'B4',
    'public-beta-b4-module-workflow',
    'module-app-cli-lifecycle',
    PLANS.moduleApp,
    ['web', 'module-host', 'api', 'trust-worker'],
    ['module-workflow-browser-trace', 'cli-sdk-validation', 'trust-review', 'module-lifecycle'],
    { visibleBrowser: true, dependsOn: ['G7', 'G8', 'G10'] },
  ),
  expectedLane(
    'B5',
    'public-beta-b5-runtime-isolation',
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
  expectedLane(
    'B6',
    'public-beta-b6-sandbox-ledger',
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
  expectedLane(
    'B7',
    'public-beta-b7-backup-recovery',
    'evidence-closure',
    PLANS.evidence,
    ['postgresql', 'private-object-storage', 'backup-store'],
    ['pitr-restore', 'object-restore', 'rpo-rto', 'restore-consistency', 'post-restore-smoke'],
    { maxAgeHours: 168, dependsOn: ['G1', 'G2'] },
  ),
  expectedLane(
    'B8',
    'public-beta-b8-telemetry-incident',
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
  expectedLane(
    'B9',
    'public-beta-b9-brand-upstream',
    'foundation-surfaces',
    PLANS.foundation,
    ['web', 'admin', 'desktop'],
    ['visible-brand-audit', 'compatibility-id-audit', 'protected-file-diff', 'upstream-rehearsal'],
    { visibleBrowser: true, packaged: true, dependsOn: ['G11'] },
  ),
  expectedLane(
    'B10',
    'public-beta-b10-two-node-deployment',
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
];

describe('public beta lane registry', () => {
  test('locks exact Gate metadata and canonical lane order', () => {
    expect(PUBLIC_BETA_LANES).toEqual(EXPECTED_LANES);
    expect(PUBLIC_BETA_LANES.map((entry) => entry.lane)).toEqual(
      EXPECTED_LANES.map((entry) => entry.lane),
    );
    expect(validatePublicBetaLanes(PUBLIC_BETA_LANES, PUBLIC_BETA_STAGES)).toEqual({
      valid: true,
    });
  });

  test('is deeply immutable and indexed by all 22 Gates', () => {
    expect(Object.isFrozen(PUBLIC_BETA_LANES)).toBe(true);
    expect(Object.keys(PUBLIC_BETA_LANES_BY_GATE).sort()).toEqual(
      EXPECTED_LANES.map((entry) => entry.gate).sort(),
    );
    for (const lane of PUBLIC_BETA_LANES) {
      expect(PUBLIC_BETA_LANES_BY_GATE[lane.gate]).toBe(lane);
      expect(Object.isFrozen(lane)).toBe(true);
      expect(Object.isFrozen(lane.requiredServices)).toBe(true);
      expect(Object.isFrozen(lane.requiredArtifacts)).toBe(true);
      expect(Object.isFrozen(lane.dependsOn)).toBe(true);
    }
  });

  test('matches program ownership exactly', () => {
    expect(validatePublicBetaProgram(PUBLIC_BETA_STAGES)).toEqual({ valid: true });
    for (const stage of PUBLIC_BETA_STAGES) {
      for (const gate of stage.gates) {
        expect(PUBLIC_BETA_LANES_BY_GATE[gate].ownerStage).toBe(stage.id);
        expect(PUBLIC_BETA_LANES_BY_GATE[gate].plan).toBe(stage.plan);
      }
    }
  });

  test('rejects duplicate identities and dependency cycles', () => {
    const duplicate = structuredClone(PUBLIC_BETA_LANES) as PublicBetaLane[];
    duplicate[1] = { ...duplicate[1]!, lane: duplicate[0]!.lane };
    expect(() => validatePublicBetaLanes(duplicate, PUBLIC_BETA_STAGES)).toThrow(
      'PUBLIC_BETA_LANE_IDENTITY_INVALID',
    );

    const cyclic = structuredClone(PUBLIC_BETA_LANES) as PublicBetaLane[];
    cyclic[0] = { ...cyclic[0]!, dependsOn: ['B10'] };
    expect(() => validatePublicBetaLanes(cyclic, PUBLIC_BETA_STAGES)).toThrow(
      'PUBLIC_BETA_LANE_DEPENDENCY_CYCLE',
    );
  });
});
