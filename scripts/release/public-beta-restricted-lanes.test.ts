import { describe, expect, test } from 'bun:test';

import {
  OPENOPC_RESTRICTED_PUBLIC_BETA_LANES,
  OPENOPC_RESTRICTED_PUBLIC_BETA_LANES_BY_GATE,
  validateOpenOpcRestrictedPublicBetaLanes,
} from './public-beta-restricted-lanes';

const GATES = [
  'G1',
  'G2',
  'G3',
  'G4',
  'G5',
  'G8',
  'G10',
  'G11',
  'G12',
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B7',
  'B8',
  'B9',
  'B10',
] as const;
const LANE_NAMES = [
  'public-beta-g1-migration',
  'public-beta-g2-artifact-storage',
  'public-beta-g3-trust-pipeline',
  'public-beta-g4-malicious-fixtures',
  'public-beta-g5-wasi',
  'public-beta-g8-tenant-authority',
  'public-beta-g10-release-lifecycle',
  'public-beta-g11-web-desktop',
  'public-beta-g12-upstream-compatibility',
  'public-beta-b1-registration',
  'public-beta-b2-web-independence',
  'public-beta-b3-admin-isolation',
  'public-beta-b4-module-workflow',
  'public-beta-b5-runtime-isolation',
  'public-beta-b7-backup-recovery',
  'public-beta-b8-telemetry-incident',
  'public-beta-b9-brand-upstream',
  'public-beta-b10-two-node-deployment',
] as const;
const DEPENDENCIES = {
  G1: [],
  G2: [],
  G3: ['G2'],
  G4: ['G3'],
  G5: ['G3'],
  G8: ['B1', 'B3'],
  G10: ['G5', 'G8'],
  G11: ['B1', 'B2', 'B3'],
  G12: ['B9'],
  B1: [],
  B2: ['B1'],
  B3: ['B1'],
  B4: ['G3', 'G4', 'G5', 'G8', 'G10'],
  B5: ['G5'],
  B7: ['G1', 'G2'],
  B8: ['B5'],
  B9: ['G11'],
  B10: ['B7', 'B8', 'G12'],
} as const;

describe('OpenOpc restricted public beta lanes', () => {
  test('owns eighteen explicit immutable lane definitions', () => {
    expect(validateOpenOpcRestrictedPublicBetaLanes()).toEqual({ valid: true });
    expect(OPENOPC_RESTRICTED_PUBLIC_BETA_LANES.map((entry) => entry.gate)).toEqual(GATES);
    expect(OPENOPC_RESTRICTED_PUBLIC_BETA_LANES.map((entry) => entry.lane)).toEqual(LANE_NAMES);
    expect(Object.isFrozen(OPENOPC_RESTRICTED_PUBLIC_BETA_LANES)).toBe(true);
    expect(Object.isFrozen(OPENOPC_RESTRICTED_PUBLIC_BETA_LANES_BY_GATE)).toBe(true);
    for (const gate of GATES) {
      const lane = OPENOPC_RESTRICTED_PUBLIC_BETA_LANES_BY_GATE[gate];
      expect(lane.dependsOn).toEqual(DEPENDENCIES[gate]);
      expect(Object.isFrozen(lane)).toBe(true);
      expect(Object.isFrozen(lane.requiredServices)).toBe(true);
      expect(Object.isFrozen(lane.requiredArtifacts)).toBe(true);
      expect(Object.isFrozen(lane.dependsOn)).toBe(true);
    }
  });

  test('contains no deferred gate or deferred runtime requirement', () => {
    const gates = OPENOPC_RESTRICTED_PUBLIC_BETA_LANES.map((entry) => entry.gate);
    for (const gate of ['G6', 'G7', 'G9', 'B6']) expect(gates).not.toContain(gate);
    const requirements = JSON.stringify(
      OPENOPC_RESTRICTED_PUBLIC_BETA_LANES.flatMap((entry) => [
        ...entry.requiredServices,
        ...entry.requiredArtifacts,
      ]),
    );
    for (const forbidden of [
      'module-host',
      'oci-runner',
      'module-ledger-worker',
      'automation-browser-worker',
    ]) {
      expect(requirements).not.toContain(forbidden);
    }
  });

  test('limits B5 and B8 to the deployed restricted services', () => {
    expect(OPENOPC_RESTRICTED_PUBLIC_BETA_LANES_BY_GATE.B5.requiredServices).toEqual([
      'wasi-runner',
      'egress-proxy',
    ]);
    expect(OPENOPC_RESTRICTED_PUBLIC_BETA_LANES_BY_GATE.B8.requiredServices).toEqual([
      'api',
      'studio-worker',
      'developer-trust-worker',
      'wasi-runner',
      'control-node',
      'execution-node',
    ]);
  });
});
