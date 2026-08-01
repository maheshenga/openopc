import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  OPENOPC_RELEASE_PROFILE_DIGESTS,
  type OpenOpcReleaseProfileId,
} from '../../packages/api-contract/src/release-profile';

export function normalizeBetaTarget(value: string): string {
  return value
    .trim()
    .replace(/[\r\n\t ]+/g, '')
    .replace(/\/+$/, '');
}

export interface BetaTargets {
  api: string;
  web: string;
  runner: string;
}

export type NormalizedBetaTargets = Readonly<BetaTargets>;

export const MODULE_BETA_ACCEPTANCE_FLOW_IDS = [
  'web_core_login',
  'desktop_core_login',
  'module_install_consent_execute_revoke_rollback',
  'web_sandbox_review_smoke',
  'server_or_wasi_review_smoke',
  'newapi_model_catalog',
  'newapi_text_completion',
  'newapi_streaming_usage_audit',
  'zpay_create_callback_lookup_refund',
  'zpay_duplicate_callback',
  'zpay_expired_late_payment_disposition',
  'capability_cross_tenant_and_revocation_rejection',
  'custom_domain_dns_tls_and_host_routing',
  'provider_failure_bounded_and_audited',
] as const;

export type ModuleBetaAcceptanceFlowId = (typeof MODULE_BETA_ACCEPTANCE_FLOW_IDS)[number];
export const MODULE_BETA_ACCEPTANCE_PROFILE_ID =
  'openopc-web-desktop-developer-beta-v2' as const satisfies OpenOpcReleaseProfileId;
export const MODULE_BETA_ACCEPTANCE_PROFILE_DIGEST =
  OPENOPC_RELEASE_PROFILE_DIGESTS[MODULE_BETA_ACCEPTANCE_PROFILE_ID];

export type DeveloperModuleBetaEvidenceOutcome = 'not-run' | 'passed' | 'failed';

export interface DeveloperModuleBetaEvidenceRecord {
  id: ModuleBetaAcceptanceFlowId;
  releaseProfileId: typeof MODULE_BETA_ACCEPTANCE_PROFILE_ID;
  releaseProfileDigest: typeof MODULE_BETA_ACCEPTANCE_PROFILE_DIGEST;
  candidateCommit: string;
  recordedAt: string;
  referenceDigest: `sha256:${string}`;
  outcome: DeveloperModuleBetaEvidenceOutcome;
  claims: string[];
}

export interface DeveloperModuleBetaEvidenceLedger {
  schemaVersion: 2;
  records: DeveloperModuleBetaEvidenceRecord[];
}

const DEVELOPER_BETA_EVIDENCE_RECORD_KEYS = [
  'candidateCommit',
  'claims',
  'id',
  'outcome',
  'recordedAt',
  'referenceDigest',
  'releaseProfileDigest',
  'releaseProfileId',
] as const;

const UNSAFE_DEVELOPER_BETA_CLAIM_PATTERNS = [
  /\borders\.close\b/i,
  /\b(?:provider|z[- ]?pay)\s+close\s+operation\b/i,
  /\bcommerce\.settlement\b/i,
  /\b(?:developer\s+balance|payout|withdrawal|split\s+payment|stripe\s+mutation)\b/i,
  /\blate\s+payment\b[\s\S]*\bauto[- ]?fulfill(?:ed|ment)?\b/i,
  /\bmissing\b[\s\S]*\b(?:credential\s+rotation|stream\s+audit)\b/i,
  /\binvalid\s+callback\s+signature\s+accepted\b/i,
  /\bduplicate\s+callback\b[\s\S]*\btwo\s+state\s+transitions\b/i,
  /\bcross[- ]tenant\s+capability\s+call\s+accepted\b/i,
  /\bcustom\s+domain\s+active\b[\s\S]*\b(?:without|missing)\b[\s\S]*\b(?:dns|tls)\b/i,
  /\bdesktop\s+policy\b[\s\S]*\bprovider\s+origin\b/i,
  /\b(?:raw\s+provider\s+credentials?|provider\s+raw\s+credentials?)\b/i,
  /\b(?:api[_ -]?key|secret|password|bearer|token)\s*[:=]\s*\S+/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/i,
  /\b(?:browser|desktop|web)\b[\s\S]*\bmodule\b[\s\S]*\b(?:called|accessed|reached|used)\b[\s\S]*\b(?:new[- ]?api|z[- ]?pay|alipay|wechat)\b/i,
  /\b(?:new[- ]?api|z[- ]?pay|alipay|wechat)\b[\s\S]*\b(?:called|accessed|reached|used)\b[\s\S]*\b(?:browser|desktop|web)\b[\s\S]*\bmodule\b/i,
] as const;

export function validateDeveloperModuleBetaEvidence(
  value: unknown,
): DeveloperModuleBetaEvidenceLedger {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'records'])) {
    throw new Error('MODULE_BETA_EVIDENCE_INVALID');
  }
  if (value.schemaVersion !== 2 || !Array.isArray(value.records)) {
    throw new Error('MODULE_BETA_EVIDENCE_INVALID');
  }
  if (value.records.length !== MODULE_BETA_ACCEPTANCE_FLOW_IDS.length) {
    throw new Error('MODULE_BETA_EVIDENCE_FLOWS_INCOMPLETE');
  }

  const expectedIds = new Set<string>(MODULE_BETA_ACCEPTANCE_FLOW_IDS);
  const records: DeveloperModuleBetaEvidenceRecord[] = [];
  for (const rawRecord of value.records) {
    if (!isRecord(rawRecord) || !hasExactKeys(rawRecord, DEVELOPER_BETA_EVIDENCE_RECORD_KEYS)) {
      throw new Error('MODULE_BETA_EVIDENCE_RECORD_INVALID');
    }
    if (
      typeof rawRecord.id !== 'string' ||
      !expectedIds.has(rawRecord.id) ||
      records.some((record) => record.id === rawRecord.id) ||
      typeof rawRecord.releaseProfileId !== 'string' ||
      rawRecord.releaseProfileId !== MODULE_BETA_ACCEPTANCE_PROFILE_ID ||
      typeof rawRecord.releaseProfileDigest !== 'string' ||
      rawRecord.releaseProfileDigest !== MODULE_BETA_ACCEPTANCE_PROFILE_DIGEST ||
      typeof rawRecord.candidateCommit !== 'string' ||
      !/^[0-9a-f]{40}$/.test(rawRecord.candidateCommit) ||
      typeof rawRecord.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(rawRecord.recordedAt)) ||
      typeof rawRecord.referenceDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(rawRecord.referenceDigest) ||
      typeof rawRecord.outcome !== 'string' ||
      !['not-run', 'passed', 'failed'].includes(rawRecord.outcome) ||
      !isStringArray(rawRecord.claims) ||
      new Set(rawRecord.claims).size !== rawRecord.claims.length
    ) {
      throw new Error('MODULE_BETA_EVIDENCE_RECORD_INVALID');
    }
    if (
      rawRecord.claims.some((claim) =>
        UNSAFE_DEVELOPER_BETA_CLAIM_PATTERNS.some((pattern) => pattern.test(claim)),
      )
    ) {
      throw new Error('MODULE_BETA_EVIDENCE_UNSAFE_CLAIM');
    }
    records.push({
      id: rawRecord.id as ModuleBetaAcceptanceFlowId,
      releaseProfileId: MODULE_BETA_ACCEPTANCE_PROFILE_ID,
      releaseProfileDigest: MODULE_BETA_ACCEPTANCE_PROFILE_DIGEST,
      candidateCommit: rawRecord.candidateCommit,
      recordedAt: rawRecord.recordedAt,
      referenceDigest: rawRecord.referenceDigest as `sha256:${string}`,
      outcome: rawRecord.outcome as DeveloperModuleBetaEvidenceOutcome,
      claims: [...rawRecord.claims],
    });
  }

  if (records.some((record, index) => record.id !== MODULE_BETA_ACCEPTANCE_FLOW_IDS[index])) {
    throw new Error('MODULE_BETA_EVIDENCE_FLOWS_INCOMPLETE');
  }
  const candidateCommit = records[0]?.candidateCommit;
  if (!candidateCommit || records.some((record) => record.candidateCommit !== candidateCommit)) {
    throw new Error('MODULE_BETA_EVIDENCE_CANDIDATE_MISMATCH');
  }
  return Object.freeze({
    schemaVersion: 2,
    records: Object.freeze(
      records.map((record) => Object.freeze(record)),
    ) as unknown as DeveloperModuleBetaEvidenceRecord[],
  });
}

const PRODUCTION_HOSTS = new Set([
  'api.kortix.com',
  'api.openopc.com',
  'kortix.com',
  'openopc.com',
  'www.kortix.com',
  'www.openopc.com',
]);
const PRODUCTION_MARKER = /prod(?:uction)?/i;

function targetIsForbidden(value: string): boolean {
  if (PRODUCTION_MARKER.test(value)) return true;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const labels = hostname.replace(/^\[|\]$/g, '').split('.');

    return (
      !['http:', 'https:'].includes(url.protocol) ||
      Boolean(url.username || url.password) ||
      PRODUCTION_HOSTS.has(hostname) ||
      labels.includes('prod') ||
      labels.includes('production') ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      /^127(?:\.|$)/.test(hostname)
    );
  } catch {
    return true;
  }
}

export function assertNonProductionBetaTargets(input: BetaTargets): NormalizedBetaTargets {
  const normalized: BetaTargets = {
    api: normalizeBetaTarget(input.api),
    web: normalizeBetaTarget(input.web),
    runner: normalizeBetaTarget(input.runner),
  };

  if (Object.values(normalized).some((value) => !value || targetIsForbidden(value))) {
    throw new Error('MODULE_BETA_TARGET_FORBIDDEN');
  }

  return Object.freeze(normalized);
}

export interface ReleaseQaTargetInput {
  api: string;
  web: string;
  dast?: string;
  pentest?: string;
  runner?: string;
  moduleBetaGatesRequired: boolean;
}

export interface ReleaseQaEnvironment {
  API_BASE_URL: string;
  KE2E_API_URL: string;
  BASE_URL: string;
  E2E_BASE_URL: string;
  TARGET_URL: string;
  PENTEST_TARGET_URL: string;
  MODULE_BETA_RUNNER_URL?: string;
  PENTEST_LIVE_CONFIRM: 'ci';
  KE2E_LIVE_CONFIRM: 'ci';
}

export function buildReleaseQaEnvironment(input: ReleaseQaTargetInput): ReleaseQaEnvironment {
  const api = normalizeBetaTarget(input.api);
  const web = normalizeBetaTarget(input.web);
  const derivedScanTarget = api.replace(/\/v1$/, '');
  const dast = normalizeBetaTarget(input.dast ?? derivedScanTarget);
  const pentest = normalizeBetaTarget(input.pentest ?? derivedScanTarget);
  const runner = normalizeBetaTarget(input.runner ?? '');

  if (!api || !web || !dast || !pentest || [api, web, dast, pentest].some(targetIsForbidden)) {
    throw new Error('RELEASE_QA_TARGET_FORBIDDEN');
  }

  if (input.moduleBetaGatesRequired || runner) {
    assertNonProductionBetaTargets({ api, web, runner });
  }

  return {
    API_BASE_URL: api,
    KE2E_API_URL: api,
    BASE_URL: api,
    E2E_BASE_URL: web,
    TARGET_URL: dast,
    PENTEST_TARGET_URL: pentest,
    ...(runner ? { MODULE_BETA_RUNNER_URL: runner } : {}),
    PENTEST_LIVE_CONFIRM: 'ci',
    KE2E_LIVE_CONFIRM: 'ci',
  };
}

export interface ModuleBetaEvidenceLedger {
  schemaVersion: 1;
  records: ModuleBetaEvidenceRecord[];
  developerBetaAcceptance?: DeveloperModuleBetaEvidenceLedger;
}

export type ModuleBetaEvidenceLane =
  | 'focused'
  | 'package'
  | 'integration'
  | 'browser'
  | 'deployment'
  | 'production';

export type ModuleBetaEvidenceOutcome = 'not-run' | 'passed' | 'failed';

export interface ModuleBetaEvidenceRecord {
  id: string;
  gate: string;
  lane: ModuleBetaEvidenceLane;
  command: string | null;
  environment: string;
  dependencyIdentities: string[];
  commit: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: ModuleBetaEvidenceOutcome;
  artifactPaths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

export function validateEvidenceLedger(value: unknown): ModuleBetaEvidenceLedger {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, 'schemaVersion') ||
    !Object.hasOwn(value, 'records') ||
    Object.keys(value).some(
      (key) => !['schemaVersion', 'records', 'developerBetaAcceptance'].includes(key),
    )
  ) {
    throw new Error('EVIDENCE_LEDGER_INVALID');
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.records)) {
    throw new Error('EVIDENCE_LEDGER_INVALID');
  }
  const recordKeys = [
    'id',
    'gate',
    'lane',
    'command',
    'environment',
    'dependencyIdentities',
    'commit',
    'startedAt',
    'finishedAt',
    'outcome',
    'artifactPaths',
  ] as const;
  if (
    value.records.some(
      (record) =>
        !isRecord(record) ||
        !hasExactKeys(record, recordKeys) ||
        typeof record.id !== 'string' ||
        record.id.trim().length === 0 ||
        typeof record.gate !== 'string' ||
        typeof record.lane !== 'string' ||
        !isNullableString(record.command) ||
        !['local', 'staging', 'production'].includes(String(record.environment)) ||
        !isStringArray(record.dependencyIdentities) ||
        !isNullableString(record.commit) ||
        !isNullableString(record.startedAt) ||
        !isNullableString(record.finishedAt) ||
        typeof record.outcome !== 'string' ||
        !isStringArray(record.artifactPaths),
    )
  ) {
    throw new Error('EVIDENCE_RECORD_INVALID');
  }

  const ledger = value as unknown as ModuleBetaEvidenceLedger;
  const expectedGates = Array.from({ length: 12 }, (_, index) => `G${index + 1}`);
  const actualGates = new Set(ledger.records.map((record) => record.gate));
  if (
    ledger.records.length !== expectedGates.length ||
    expectedGates.some((gate) => !actualGates.has(gate))
  ) {
    throw new Error('EVIDENCE_GATES_INCOMPLETE');
  }

  const ids = new Set(ledger.records.map((record) => record.id));
  if (ids.size !== ledger.records.length) {
    throw new Error('EVIDENCE_ID_DUPLICATE');
  }

  const evidenceLanes = new Set<ModuleBetaEvidenceLane>([
    'focused',
    'package',
    'integration',
    'browser',
    'deployment',
    'production',
  ]);
  const evidenceOutcomes = new Set<ModuleBetaEvidenceOutcome>(['not-run', 'passed', 'failed']);
  for (const record of ledger.records) {
    if (!evidenceLanes.has(record.lane) || !evidenceOutcomes.has(record.outcome)) {
      throw new Error('EVIDENCE_RECORD_INVALID');
    }
    if (record.outcome === 'passed' && record.dependencyIdentities.length === 0) {
      throw new Error('EVIDENCE_DEPENDENCY_IDENTITY_REQUIRED');
    }
    if (
      record.outcome === 'passed' &&
      (!Array.isArray(record.artifactPaths) || record.artifactPaths.length === 0)
    ) {
      throw new Error('EVIDENCE_ARTIFACT_REQUIRED');
    }
    if (record.outcome === 'passed') {
      const startedAt =
        typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : Number.NaN;
      const finishedAt =
        typeof record.finishedAt === 'string' ? Date.parse(record.finishedAt) : Number.NaN;
      if (
        typeof record.command !== 'string' ||
        record.command.trim().length === 0 ||
        typeof record.commit !== 'string' ||
        !/^[0-9a-f]{7,40}$/.test(record.commit) ||
        !Number.isFinite(startedAt) ||
        !Number.isFinite(finishedAt) ||
        finishedAt < startedAt
      ) {
        throw new Error('EVIDENCE_RUN_METADATA_REQUIRED');
      }
    }
  }
  if (ledger.developerBetaAcceptance !== undefined) {
    validateDeveloperModuleBetaEvidence(ledger.developerBetaAcceptance);
  }
  return ledger;
}

function requiredArgument(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a file path`);
  return value;
}

export function formatGithubEnvironment(environment: ReleaseQaEnvironment): string {
  return `${Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

async function main(args: string[]): Promise<void> {
  if (args[0] === '--check-fixture') {
    const path = resolve(requiredArgument(args, 1, '--check-fixture'));
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (isRecord(value) && value.schemaVersion === 2) {
      validateDeveloperModuleBetaEvidence(value);
    } else {
      validateEvidenceLedger(value);
    }
    console.log(`[module-beta] evidence ledger valid: ${path}`);
    return;
  }

  if (args[0] === '--github-env') {
    const githubEnv = process.env.GITHUB_ENV;
    if (!githubEnv) throw new Error('GITHUB_ENV is required for --github-env');
    const environment = buildReleaseQaEnvironment({
      api: process.env.API_BASE_URL_INPUT ?? '',
      web: process.env.WEB_BASE_URL_INPUT ?? '',
      dast: process.env.DAST_TARGET_URL_INPUT,
      pentest: process.env.PENTEST_TARGET_URL_INPUT,
      runner: process.env.MODULE_BETA_RUNNER_URL_INPUT,
      moduleBetaGatesRequired: process.env.MODULE_BETA_GATES_REQUIRED === 'true',
    });
    appendFileSync(githubEnv, formatGithubEnvironment(environment), 'utf8');
    console.log(`[module-beta] release API target: ${environment.API_BASE_URL}`);
    console.log(`[module-beta] release Web target: ${environment.E2E_BASE_URL}`);
    console.log(`[module-beta] release DAST target: ${environment.TARGET_URL}`);
    console.log(`[module-beta] release pentest target: ${environment.PENTEST_TARGET_URL}`);
    if (environment.MODULE_BETA_RUNNER_URL) {
      console.log(`[module-beta] module Runner target: ${environment.MODULE_BETA_RUNNER_URL}`);
    }
    return;
  }

  throw new Error(
    'Usage: bun scripts/release/module-beta-targets.ts --check-fixture <path> | --github-env',
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[module-beta] ${message}`);
    process.exitCode = 1;
  });
}
