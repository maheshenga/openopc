import { createHash } from 'node:crypto';
import type { RegistryModuleLockGraph, RegistryModuleVerificationProfile } from '@kortix/registry';

import type {
  DeveloperTrustPolicyV1,
  DeveloperTrustScannerName,
  DeveloperTrustScannerPolicy,
} from '../policy';

export type ScannerState = 'passed' | 'failed' | 'inconclusive';
export type ScannerSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface ScannerFinding {
  fingerprint: `sha256:${string}`;
  scanner: DeveloperTrustScannerName;
  ruleId: string;
  severity: ScannerSeverity;
  path: string | null;
  location: Record<string, number> | null;
  summary: string;
  disposition: 'blocking' | 'observed';
}

export interface ScannerInput {
  workspacePath: string;
  moduleId: string;
  moduleVersion: string;
  artifactDigest: `sha256:${string}`;
  verificationProfile: RegistryModuleVerificationProfile;
  lockGraph: RegistryModuleLockGraph | null;
  dependencyLicenses: ReadonlyArray<{ name: string; version: string; license: string }>;
}

export interface CycloneDxBom {
  bomFormat: 'CycloneDX';
  specVersion: '1.6';
  version: 1;
  components: ReadonlyArray<Record<string, unknown>>;
  dependencies?: ReadonlyArray<Record<string, unknown>>;
}

export interface ScannerResult {
  scanner: DeveloperTrustScannerName;
  state: ScannerState;
  findings: ScannerFinding[];
  evidenceDigest: `sha256:${string}`;
  terminalReason: string | null;
  sbom?: CycloneDxBom;
}

export type ScannerProcessResult =
  | { kind: 'completed'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'inconclusive'; reason: string };

export interface ScannerCommandRunner {
  verifyIdentity(scanner: DeveloperTrustScannerPolicy): Promise<void>;
  run(input: {
    scanner: DeveloperTrustScannerPolicy;
    args: readonly string[];
    scanInput: ScannerInput;
    signal: AbortSignal;
  }): Promise<ScannerProcessResult>;
}

export interface DeveloperScannerAdapter {
  readonly name: DeveloperTrustScannerName;
  verifyIdentity(policy: DeveloperTrustPolicyV1): Promise<void>;
  scan(input: ScannerInput, signal: AbortSignal): Promise<ScannerResult>;
}

const SAFE_PROCESS_REASONS = new Set([
  'cancelled',
  'identity_mismatch',
  'invalid_configuration',
  'output_limit_exceeded',
  'process_terminated',
  'process_unavailable',
  'scanner_unavailable',
  'timeout',
  'workspace_cleanup_failed',
  'workspace_prepare_failed',
]);

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_JSON_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new TypeError('NON_JSON_VALUE');
}

export function evidenceDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function safeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._:@/+\-]/g, '-')
    .slice(0, 128);
  return normalized.length > 0 ? normalized : fallback;
}

function safeRelativePath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    return null;
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.split('/').some((segment) => segment === '..')) return null;
  return normalized;
}

export function createScannerFinding(input: {
  scanner: DeveloperTrustScannerName;
  ruleId: unknown;
  severity: ScannerSeverity;
  path?: unknown;
  location?: Record<string, number> | null;
  summary: string;
}): ScannerFinding {
  const ruleId = safeIdentifier(input.ruleId, 'unknown');
  const path = safeRelativePath(input.path);
  const location = input.location
    ? Object.fromEntries(
        Object.entries(input.location)
          .filter(([, value]) => Number.isSafeInteger(value) && value > 0)
          .sort(([left], [right]) => compareText(left, right)),
      )
    : null;
  const disposition =
    input.severity === 'critical' || input.severity === 'high' ? 'blocking' : 'observed';
  const normalized = {
    scanner: input.scanner,
    ruleId,
    severity: input.severity,
    path,
    location: location && Object.keys(location).length > 0 ? location : null,
    summary: input.summary.slice(0, 240),
    disposition,
  } as const;
  return { fingerprint: evidenceDigest(normalized), ...normalized };
}

export function completedScannerResult(input: {
  scanner: DeveloperTrustScannerName;
  findings: ScannerFinding[];
  sbom?: CycloneDxBom;
}): ScannerResult {
  const findings = [...input.findings].sort(
    (left, right) =>
      compareText(left.fingerprint, right.fingerprint) || compareText(left.ruleId, right.ruleId),
  );
  const state: ScannerState = findings.some((finding) => finding.disposition === 'blocking')
    ? 'failed'
    : 'passed';
  const normalized = {
    scanner: input.scanner,
    state,
    findings,
    ...(input.sbom ? { sbom: input.sbom } : {}),
  };
  return { ...normalized, evidenceDigest: evidenceDigest(normalized), terminalReason: null };
}

export function inconclusiveScannerResult(
  name: DeveloperTrustScannerName,
  reason: string,
): ScannerResult {
  const terminalReason =
    reason === 'malformed_output' || reason === 'scanner_crash' || SAFE_PROCESS_REASONS.has(reason)
      ? reason
      : 'scanner_unavailable';
  const normalized = { scanner: name, state: 'inconclusive' as const, terminalReason };
  return {
    ...normalized,
    findings: [],
    evidenceDigest: evidenceDigest(normalized),
  };
}

export function createScannerRuntime(
  name: DeveloperTrustScannerName,
  runner: ScannerCommandRunner,
): {
  verifyIdentity(policy: DeveloperTrustPolicyV1): Promise<void>;
  run(
    input: ScannerInput,
    signal: AbortSignal,
    args: readonly string[],
  ): Promise<ScannerProcessResult>;
} {
  let scanner: DeveloperTrustScannerPolicy = {
    name,
    executable: `/unconfigured/openopc-${name}`,
    imageDigest: `sha256:${'0'.repeat(64)}`,
    version: 'unconfigured',
    ruleDigest: `sha256:${'0'.repeat(64)}`,
    timeoutMs: 1,
    maxOutputBytes: 1,
  };
  return {
    async verifyIdentity(policy) {
      const configured = policy.scanners.find((entry) => entry.name === name);
      if (!configured) throw new Error('SCANNER_POLICY_MISSING');
      await runner.verifyIdentity(configured);
      scanner = configured;
    },
    async run(input, signal, args) {
      try {
        const result = await runner.run({ scanner, args, scanInput: input, signal });
        return result.kind === 'inconclusive'
          ? {
              kind: 'inconclusive',
              reason: SAFE_PROCESS_REASONS.has(result.reason)
                ? result.reason
                : 'scanner_unavailable',
            }
          : result;
      } catch {
        return { kind: 'inconclusive', reason: 'scanner_crash' };
      }
    },
  };
}
