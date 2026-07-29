import { describe, expect, test } from 'bun:test';
import {
  PUBLIC_BETA_STAGES,
  type PublicBetaStage,
  validatePublicBetaProgram,
} from './public-beta-program';

describe('public beta program', () => {
  test('owns every required gate exactly once in dependency order', () => {
    expect(validatePublicBetaProgram(PUBLIC_BETA_STAGES)).toEqual({ valid: true });
    expect(PUBLIC_BETA_STAGES.flatMap((stage) => stage.gates).sort()).toEqual([
      'B1',
      'B10',
      'B2',
      'B3',
      'B4',
      'B5',
      'B6',
      'B7',
      'B8',
      'B9',
      'G1',
      'G10',
      'G11',
      'G12',
      'G2',
      'G3',
      'G4',
      'G5',
      'G6',
      'G7',
      'G8',
      'G9',
    ]);
  });

  test('rejects duplicate or missing gate ownership', () => {
    const duplicate = structuredClone(PUBLIC_BETA_STAGES) as PublicBetaStage[];
    duplicate[0] = { ...duplicate[0]!, gates: ['G1'] };
    expect(() => validatePublicBetaProgram(duplicate)).toThrow(
      'PUBLIC_BETA_GATE_OWNERSHIP_INVALID',
    );

    const missing = structuredClone(PUBLIC_BETA_STAGES) as PublicBetaStage[];
    missing[missing.length - 1] = {
      ...missing[missing.length - 1]!,
      gates: missing[missing.length - 1]!.gates.filter((gate) => gate !== 'B10'),
    };
    expect(() => validatePublicBetaProgram(missing)).toThrow(
      'PUBLIC_BETA_GATE_OWNERSHIP_INVALID',
    );
  });

  test('rejects unknown, duplicate, or forward stage dependencies', () => {
    const duplicateStage = structuredClone(PUBLIC_BETA_STAGES) as PublicBetaStage[];
    duplicateStage.push({ ...duplicateStage[0]! });
    expect(() => validatePublicBetaProgram(duplicateStage)).toThrow(
      'PUBLIC_BETA_STAGE_ORDER_INVALID',
    );

    const forwardDependency = structuredClone(PUBLIC_BETA_STAGES) as PublicBetaStage[];
    forwardDependency[0] = {
      ...forwardDependency[0]!,
      dependsOn: ['evidence-closure'],
    };
    expect(() => validatePublicBetaProgram(forwardDependency)).toThrow(
      'PUBLIC_BETA_STAGE_ORDER_INVALID',
    );
  });
});
