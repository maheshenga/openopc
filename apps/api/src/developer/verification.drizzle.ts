import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';

import {
  type DeveloperModuleTrustView,
  type DeveloperModuleVerificationAttemptView,
  type DeveloperModuleVerificationClaim,
  DeveloperModuleVerificationError,
  type DeveloperModuleVerificationFindingView,
  type DeveloperModuleVerificationRepository,
  type DeveloperModuleVerificationRun,
  type FinalizeVerificationInput,
  assertValidDeveloperModuleVerificationFinalization,
} from './verification';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Pick<Database, 'execute'> | Pick<Transaction, 'execute'>;
type Row = Record<string, unknown>;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const WORKER_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

function fail(
  code: ConstructorParameters<typeof DeveloperModuleVerificationError>[0],
  status: ConstructorParameters<typeof DeveloperModuleVerificationError>[1],
): never {
  throw new DeveloperModuleVerificationError(code, status);
}

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Row[] }).rows;
  }
  return [];
}

function value(row: Row, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}

function stringValue(row: Row, camel: string, snake: string): string {
  const candidate = value(row, camel, snake);
  if (typeof candidate !== 'string') throw new TypeError(`Missing verification row field ${camel}`);
  return candidate;
}

function nullableString(row: Row, camel: string, snake: string): string | null {
  const candidate = value(row, camel, snake);
  return candidate === null || candidate === undefined ? null : String(candidate);
}

function numberValue(row: Row, camel: string, snake: string): number {
  const candidate = Number(value(row, camel, snake));
  if (!Number.isFinite(candidate)) throw new TypeError(`Missing verification row field ${camel}`);
  return candidate;
}

function hashToken(token: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function validateLease(workerId: string, leaseMs: number): void {
  if (
    !WORKER_ID.test(workerId) ||
    !Number.isInteger(leaseMs) ||
    leaseMs < 1_000 ||
    leaseMs > 900_000
  ) {
    fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
  }
}

function validateDigest(value: string): void {
  if (!SHA256_DIGEST.test(value)) fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
}

function serializeRun(row: Row): DeveloperModuleVerificationRun {
  return {
    run_id: stringValue(row, 'runId', 'run_id'),
    release_id: stringValue(row, 'releaseId', 'release_id'),
    artifact_id: stringValue(row, 'artifactId', 'artifact_id'),
    account_id: stringValue(row, 'accountId', 'account_id'),
    policy_digest: stringValue(row, 'policyDigest', 'policy_digest') as `sha256:${string}`,
    scanner_set_digest: stringValue(
      row,
      'scannerSetDigest',
      'scanner_set_digest',
    ) as `sha256:${string}`,
    sandbox_profile_digest: stringValue(
      row,
      'sandboxProfileDigest',
      'sandbox_profile_digest',
    ) as `sha256:${string}`,
    attempt: numberValue(row, 'attempt', 'attempt'),
    state: stringValue(row, 'state', 'state') as DeveloperModuleVerificationRun['state'],
    lease_owner: nullableString(row, 'leaseOwner', 'lease_owner'),
    lease_expires_at: nullableString(row, 'leaseExpiresAt', 'lease_expires_at'),
    heartbeat_at: nullableString(row, 'heartbeatAt', 'heartbeat_at'),
    terminal_reason: nullableString(row, 'terminalReason', 'terminal_reason'),
    sbom_digest: nullableString(row, 'sbomDigest', 'sbom_digest') as `sha256:${string}` | null,
    attestation_digest: nullableString(row, 'attestationDigest', 'attestation_digest') as
      | `sha256:${string}`
      | null,
    started_at: nullableString(row, 'startedAt', 'started_at'),
    finished_at: nullableString(row, 'finishedAt', 'finished_at'),
    created_at: stringValue(row, 'createdAt', 'created_at'),
    updated_at: stringValue(row, 'updatedAt', 'updated_at'),
  };
}

const RUN_RETURNING = sql.raw(`
  run_id AS "runId",
  release_id AS "releaseId",
  artifact_id AS "artifactId",
  account_id AS "accountId",
  policy_digest AS "policyDigest",
  scanner_set_digest AS "scannerSetDigest",
  sandbox_profile_digest AS "sandboxProfileDigest",
  attempt,
  state,
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  heartbeat_at AS "heartbeatAt",
  terminal_reason AS "terminalReason",
  sbom_digest AS "sbomDigest",
  attestation_digest AS "attestationDigest",
  started_at AS "startedAt",
  finished_at AS "finishedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`);

async function loadTrustView(
  executor: Executor,
  releaseId: string,
  accountId?: string,
): Promise<DeveloperModuleTrustView | null> {
  const accountPredicate = accountId ? sql`AND release.account_id = ${accountId}` : sql``;
  const result = await executor.execute(sql`
    SELECT
      release.release_id AS "releaseId",
      release.account_id AS "accountId",
      artifact.artifact_id AS "artifactId",
      artifact.artifact_digest AS "artifactDigest",
      artifact.media_type AS "mediaType",
      artifact.size_bytes AS "sizeBytes",
      artifact.source_provenance AS "sourceProvenance",
      artifact.created_at AS "artifactCreatedAt",
      run.run_id AS "runId",
      run.attempt AS "attempt",
      run.state AS "state",
      run.policy_digest AS "policyDigest",
      run.scanner_set_digest AS "scannerSetDigest",
      run.sandbox_profile_digest AS "sandboxProfileDigest",
      run.terminal_reason AS "terminalReason",
      run.sbom_digest AS "sbomDigest",
      run.attestation_digest AS "attestationDigest",
      run.started_at AS "startedAt",
      run.finished_at AS "finishedAt",
      run.created_at AS "runCreatedAt",
      finding.finding_id AS "findingId",
      finding.fingerprint AS "findingFingerprint",
      finding.scanner AS "findingScanner",
      finding.rule_id AS "findingRuleId",
      finding.severity AS "findingSeverity",
      finding.path AS "findingPath",
      finding.location AS "findingLocation",
      finding.summary AS "findingSummary",
      finding.disposition AS "findingDisposition",
      finding.created_at AS "findingCreatedAt",
      attestation.attestation_digest AS "safeAttestationDigest",
      attestation.subject_artifact_digest AS "subjectArtifactDigest",
      attestation.predicate_type AS "predicateType",
      attestation.policy_digest AS "attestationPolicyDigest",
      attestation.result AS "attestationResult",
      attestation.sbom_digest AS "attestationSbomDigest",
      attestation.issuer AS "attestationIssuer",
      attestation.created_at AS "attestationCreatedAt"
    FROM kortix.developer_module_releases release
    INNER JOIN kortix.developer_module_artifacts artifact
      ON artifact.artifact_id = release.artifact_id
     AND artifact.account_id = release.account_id
    LEFT JOIN kortix.developer_module_verification_runs run
      ON run.release_id = release.release_id
     AND run.account_id = release.account_id
    LEFT JOIN kortix.developer_module_verification_findings finding
      ON finding.run_id = run.run_id
     AND finding.account_id = run.account_id
    LEFT JOIN kortix.developer_module_trust_attestations attestation
      ON attestation.run_id = run.run_id
     AND attestation.account_id = run.account_id
    WHERE release.release_id = ${releaseId}
      ${accountPredicate}
    ORDER BY run.attempt ASC, finding.created_at ASC, finding.finding_id ASC
  `);
  const resultRows = rows(result);
  const first = resultRows[0];
  if (!first) return null;
  const attempts = new Map<string, DeveloperModuleVerificationAttemptView>();
  for (const row of resultRows) {
    const runId = nullableString(row, 'runId', 'run_id');
    if (!runId) continue;
    let attempt = attempts.get(runId);
    if (!attempt) {
      const safeAttestationDigest = nullableString(
        row,
        'safeAttestationDigest',
        'safe_attestation_digest',
      );
      attempt = {
        run_id: runId,
        attempt: numberValue(row, 'attempt', 'attempt'),
        state: stringValue(row, 'state', 'state') as DeveloperModuleVerificationRun['state'],
        policy_digest: stringValue(row, 'policyDigest', 'policy_digest') as `sha256:${string}`,
        scanner_set_digest: stringValue(
          row,
          'scannerSetDigest',
          'scanner_set_digest',
        ) as `sha256:${string}`,
        sandbox_profile_digest: stringValue(
          row,
          'sandboxProfileDigest',
          'sandbox_profile_digest',
        ) as `sha256:${string}`,
        terminal_reason: nullableString(row, 'terminalReason', 'terminal_reason'),
        sbom_digest: nullableString(row, 'sbomDigest', 'sbom_digest') as `sha256:${string}` | null,
        attestation_digest: nullableString(row, 'attestationDigest', 'attestation_digest') as
          | `sha256:${string}`
          | null,
        started_at: nullableString(row, 'startedAt', 'started_at'),
        finished_at: nullableString(row, 'finishedAt', 'finished_at'),
        created_at: stringValue(row, 'runCreatedAt', 'run_created_at'),
        findings: [],
        attestation: safeAttestationDigest
          ? {
              attestation_digest: safeAttestationDigest as `sha256:${string}`,
              subject_artifact_digest: stringValue(
                row,
                'subjectArtifactDigest',
                'subject_artifact_digest',
              ) as `sha256:${string}`,
              predicate_type: stringValue(row, 'predicateType', 'predicate_type'),
              policy_digest: stringValue(
                row,
                'attestationPolicyDigest',
                'attestation_policy_digest',
              ) as `sha256:${string}`,
              result: stringValue(row, 'attestationResult', 'attestation_result') as NonNullable<
                DeveloperModuleVerificationAttemptView['attestation']
              >['result'],
              sbom_digest: stringValue(
                row,
                'attestationSbomDigest',
                'attestation_sbom_digest',
              ) as `sha256:${string}`,
              issuer: stringValue(row, 'attestationIssuer', 'attestation_issuer'),
              created_at: stringValue(row, 'attestationCreatedAt', 'attestation_created_at'),
            }
          : null,
      };
      attempts.set(runId, attempt);
    }
    const findingId = nullableString(row, 'findingId', 'finding_id');
    if (findingId && !attempt.findings.some((finding) => finding.finding_id === findingId)) {
      const finding: DeveloperModuleVerificationFindingView = {
        finding_id: findingId,
        fingerprint: stringValue(
          row,
          'findingFingerprint',
          'finding_fingerprint',
        ) as `sha256:${string}`,
        scanner: stringValue(row, 'findingScanner', 'finding_scanner'),
        rule_id: stringValue(row, 'findingRuleId', 'finding_rule_id'),
        severity: stringValue(
          row,
          'findingSeverity',
          'finding_severity',
        ) as DeveloperModuleVerificationFindingView['severity'],
        path: nullableString(row, 'findingPath', 'finding_path'),
        location: (value(row, 'findingLocation', 'finding_location') ?? null) as Record<
          string,
          unknown
        > | null,
        summary: stringValue(row, 'findingSummary', 'finding_summary'),
        disposition: stringValue(
          row,
          'findingDisposition',
          'finding_disposition',
        ) as DeveloperModuleVerificationFindingView['disposition'],
        created_at: stringValue(row, 'findingCreatedAt', 'finding_created_at'),
      };
      attempt.findings.push(finding);
    }
  }
  return {
    release_id: stringValue(first, 'releaseId', 'release_id'),
    account_id: stringValue(first, 'accountId', 'account_id'),
    artifact: {
      artifact_id: stringValue(first, 'artifactId', 'artifact_id'),
      artifact_digest: stringValue(
        first,
        'artifactDigest',
        'artifact_digest',
      ) as `sha256:${string}`,
      media_type: stringValue(first, 'mediaType', 'media_type'),
      size_bytes: numberValue(first, 'sizeBytes', 'size_bytes'),
      source_provenance: (value(first, 'sourceProvenance', 'source_provenance') ?? null) as Record<
        string,
        unknown
      > | null,
      created_at: stringValue(first, 'artifactCreatedAt', 'artifact_created_at'),
    },
    attempts: [...attempts.values()].sort((left, right) => left.attempt - right.attempt),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new TypeError('Only JSON values are supported');
}

function finalizationIdentity(input: FinalizeVerificationInput) {
  return {
    artifactDigest: input.artifactDigest,
    policyDigest: input.policyDigest,
    scannerSetDigest: input.scannerSetDigest,
    result: input.result,
    terminalReason: input.terminalReason.trim(),
    sbomDigest: input.sbomDigest,
    resourceSummary: input.resourceSummary,
    findings: input.findings,
    attestation: input.attestation,
  };
}

export function createDrizzleDeveloperModuleVerificationRepository(
  db: Database,
  options?: {
    now?: () => Date;
    createLeaseToken?: () => string;
  },
): DeveloperModuleVerificationRepository {
  const now = options?.now ?? (() => new Date());
  const createLeaseToken =
    options?.createLeaseToken ?? (() => randomBytes(32).toString('base64url'));

  return {
    async enqueue(input) {
      for (const candidate of [
        input.artifactDigest,
        input.policyDigest,
        input.scannerSetDigest,
        input.sandboxProfileDigest,
      ]) {
        validateDigest(candidate);
      }
      const result = await db.execute(sql`
        INSERT INTO kortix.developer_module_verification_runs (
          release_id, artifact_id, account_id, policy_digest, scanner_set_digest,
          sandbox_profile_digest, attempt, state
        )
        SELECT
          release.release_id,
          release.artifact_id,
          release.account_id,
          ${input.policyDigest},
          ${input.scannerSetDigest},
          ${input.sandboxProfileDigest},
          COALESCE((
            SELECT MAX(previous.attempt)
            FROM kortix.developer_module_verification_runs previous
            WHERE previous.release_id = release.release_id
          ), 0) + 1,
          'queued'
        FROM kortix.developer_module_releases release
        INNER JOIN kortix.developer_module_artifacts artifact
          ON artifact.artifact_id = release.artifact_id
         AND artifact.account_id = release.account_id
        WHERE release.release_id = ${input.releaseId}
          AND release.account_id = ${input.accountId}
          AND release.artifact_id = ${input.artifactId}
          AND artifact.artifact_digest = ${input.artifactDigest}
          AND NOT EXISTS (
            SELECT 1
            FROM kortix.developer_module_verification_runs active
            WHERE active.release_id = release.release_id
              AND active.policy_digest = ${input.policyDigest}
              AND active.state IN ('queued', 'running')
          )
        RETURNING ${RUN_RETURNING}
      `);
      const row = rows(result)[0];
      if (!row) fail('DEVELOPER_VERIFICATION_CONFLICT', 409);
      return serializeRun(row);
    },

    async claim(input): Promise<DeveloperModuleVerificationClaim | null> {
      validateLease(input.workerId, input.leaseMs);
      return db.transaction(async (tx) => {
        const current = now();
        const leaseToken = createLeaseToken();
        if (!Number.isFinite(current.getTime()) || !/^[A-Za-z0-9_-]{43}$/.test(leaseToken)) {
          fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
        }
        const leaseExpiresAt = new Date(current.getTime() + input.leaseMs).toISOString();
        const result = await tx.execute(sql`
          WITH candidate AS (
            SELECT run.run_id
            FROM kortix.developer_module_verification_runs run
            WHERE run.state = 'queued'
               OR (run.state = 'running' AND run.lease_expires_at <= ${current.toISOString()})
            ORDER BY run.created_at ASC, run.run_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE kortix.developer_module_verification_runs run
          SET state = 'running',
              lease_owner = ${input.workerId},
              lease_token_hash = ${hashToken(leaseToken)},
              lease_expires_at = ${leaseExpiresAt},
              heartbeat_at = ${current.toISOString()},
              started_at = COALESCE(run.started_at, ${current.toISOString()}),
              updated_at = ${current.toISOString()}
          FROM candidate, kortix.developer_module_artifacts artifact
          WHERE run.run_id = candidate.run_id
            AND artifact.artifact_id = run.artifact_id
            AND artifact.account_id = run.account_id
          RETURNING
            run.run_id AS "runId",
            run.release_id AS "releaseId",
            run.account_id AS "accountId",
            run.artifact_id AS "artifactId",
            artifact.artifact_digest AS "artifactDigest",
            run.policy_digest AS "policyDigest",
            run.scanner_set_digest AS "scannerSetDigest",
            run.attempt AS "attempt",
            run.lease_expires_at AS "leaseExpiresAt"
        `);
        const row = rows(result)[0];
        if (!row) return null;
        return {
          runId: stringValue(row, 'runId', 'run_id'),
          releaseId: stringValue(row, 'releaseId', 'release_id'),
          accountId: stringValue(row, 'accountId', 'account_id'),
          artifactId: stringValue(row, 'artifactId', 'artifact_id'),
          artifactDigest: stringValue(
            row,
            'artifactDigest',
            'artifact_digest',
          ) as `sha256:${string}`,
          policyDigest: stringValue(row, 'policyDigest', 'policy_digest') as `sha256:${string}`,
          scannerSetDigest: stringValue(
            row,
            'scannerSetDigest',
            'scanner_set_digest',
          ) as `sha256:${string}`,
          attempt: numberValue(row, 'attempt', 'attempt'),
          leaseToken,
          leaseExpiresAt: stringValue(row, 'leaseExpiresAt', 'lease_expires_at'),
        };
      });
    },

    async heartbeat(input) {
      validateLease(input.workerId, input.leaseMs);
      const current = now();
      const result = await db.execute(sql`
        UPDATE kortix.developer_module_verification_runs
        SET heartbeat_at = ${current.toISOString()},
            lease_expires_at = ${new Date(current.getTime() + input.leaseMs).toISOString()},
            updated_at = ${current.toISOString()}
        WHERE run_id = ${input.runId}
          AND state = 'running'
          AND lease_owner = ${input.workerId}
          AND lease_token_hash = ${hashToken(input.leaseToken)}
          AND lease_expires_at > ${current.toISOString()}
        RETURNING run_id
      `);
      if (rows(result).length === 0) fail('DEVELOPER_VERIFICATION_LEASE_LOST', 409);
    },

    async finalize(input) {
      assertValidDeveloperModuleVerificationFinalization(input);
      return db.transaction(async (tx) => {
        const current = now();
        const lockedResult = await tx.execute(sql`
          SELECT
            run.*,
            artifact.artifact_digest AS "artifactDigest"
          FROM kortix.developer_module_verification_runs run
          INNER JOIN kortix.developer_module_artifacts artifact
            ON artifact.artifact_id = run.artifact_id
           AND artifact.account_id = run.account_id
          WHERE run.run_id = ${input.runId}
          FOR UPDATE
        `);
        const locked = rows(lockedResult)[0];
        if (!locked) fail('DEVELOPER_VERIFICATION_LEASE_LOST', 409);
        const state = stringValue(locked, 'state', 'state');
        if (['passed', 'failed', 'inconclusive', 'cancelled'].includes(state)) {
          const replay = await tx.execute(sql`
            SELECT
              run.terminal_reason AS "terminalReason",
              run.sbom_digest AS "sbomDigest",
              run.resource_summary AS "resourceSummary",
              run.state AS "result",
              run.scanner_set_digest AS "scannerSetDigest",
              artifact.artifact_digest AS "artifactDigest",
              finding.fingerprint,
              finding.scanner,
              finding.rule_id AS "ruleId",
              finding.severity,
              finding.path,
              finding.location,
              finding.summary,
              finding.disposition,
              attestation.attestation_digest AS "attestationDigest",
              attestation.subject_artifact_digest AS "subjectArtifactDigest",
              attestation.predicate_type AS "predicateType",
              attestation.policy_digest AS "attestationPolicyDigest",
              attestation.result AS "attestationResult",
              attestation.sbom_digest AS "attestationSbomDigest",
              attestation.dsse_envelope AS "dsseEnvelope",
              attestation.issuer
            FROM kortix.developer_module_verification_runs run
            INNER JOIN kortix.developer_module_artifacts artifact
              ON artifact.artifact_id = run.artifact_id
             AND artifact.account_id = run.account_id
            LEFT JOIN kortix.developer_module_verification_findings finding
              ON finding.run_id = run.run_id
             AND finding.account_id = run.account_id
            LEFT JOIN kortix.developer_module_trust_attestations attestation
              ON attestation.run_id = run.run_id
             AND attestation.account_id = run.account_id
            WHERE run.run_id = ${input.runId}
            ORDER BY finding.created_at, finding.finding_id
          `);
          const replayRows = rows(replay);
          const first = replayRows[0];
          if (first) {
            const storedIdentity = {
              artifactDigest: stringValue(first, 'artifactDigest', 'artifact_digest'),
              policyDigest: stringValue(locked, 'policyDigest', 'policy_digest'),
              scannerSetDigest: stringValue(first, 'scannerSetDigest', 'scanner_set_digest'),
              result: stringValue(first, 'result', 'result'),
              terminalReason: stringValue(first, 'terminalReason', 'terminal_reason'),
              sbomDigest: stringValue(first, 'sbomDigest', 'sbom_digest'),
              resourceSummary: value(first, 'resourceSummary', 'resource_summary') ?? {},
              findings: replayRows
                .filter((row) => nullableString(row, 'fingerprint', 'fingerprint'))
                .map((row) => ({
                  fingerprint: stringValue(row, 'fingerprint', 'fingerprint'),
                  scanner: stringValue(row, 'scanner', 'scanner'),
                  ruleId: stringValue(row, 'ruleId', 'rule_id'),
                  severity: stringValue(row, 'severity', 'severity'),
                  path: nullableString(row, 'path', 'path'),
                  location: value(row, 'location', 'location') ?? null,
                  summary: stringValue(row, 'summary', 'summary'),
                  disposition: stringValue(row, 'disposition', 'disposition'),
                })),
              attestation: {
                attestationDigest: stringValue(first, 'attestationDigest', 'attestation_digest'),
                subjectArtifactDigest: stringValue(
                  first,
                  'subjectArtifactDigest',
                  'subject_artifact_digest',
                ),
                predicateType: stringValue(first, 'predicateType', 'predicate_type'),
                policyDigest: stringValue(
                  first,
                  'attestationPolicyDigest',
                  'attestation_policy_digest',
                ),
                result: stringValue(first, 'attestationResult', 'attestation_result'),
                sbomDigest: stringValue(first, 'attestationSbomDigest', 'attestation_sbom_digest'),
                dsseEnvelope: value(first, 'dsseEnvelope', 'dsse_envelope'),
                issuer: stringValue(first, 'issuer', 'issuer'),
              },
            };
            if (canonicalJson(storedIdentity) === canonicalJson(finalizationIdentity(input))) {
              return serializeRun(locked);
            }
          }
          fail('DEVELOPER_VERIFICATION_ALREADY_FINALIZED', 409);
        }
        if (
          state !== 'running' ||
          stringValue(locked, 'leaseOwner', 'lease_owner') !== input.workerId ||
          stringValue(locked, 'leaseTokenHash', 'lease_token_hash') !==
            hashToken(input.leaseToken) ||
          new Date(stringValue(locked, 'leaseExpiresAt', 'lease_expires_at')).getTime() <=
            current.getTime()
        ) {
          fail('DEVELOPER_VERIFICATION_LEASE_LOST', 409);
        }
        if (
          stringValue(locked, 'artifactDigest', 'artifact_digest') !== input.artifactDigest ||
          stringValue(locked, 'policyDigest', 'policy_digest') !== input.policyDigest ||
          stringValue(locked, 'scannerSetDigest', 'scanner_set_digest') !==
            input.scannerSetDigest ||
          input.attestation.subjectArtifactDigest !== input.artifactDigest ||
          input.attestation.policyDigest !== input.policyDigest ||
          input.attestation.sbomDigest !== input.sbomDigest
        ) {
          fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
        }
        for (const finding of input.findings) {
          await tx.execute(sql`
            INSERT INTO kortix.developer_module_verification_findings (
              run_id, account_id, fingerprint, scanner, rule_id, severity,
              path, location, summary, disposition
            ) VALUES (
              ${input.runId},
              ${stringValue(locked, 'accountId', 'account_id')},
              ${finding.fingerprint},
              ${finding.scanner.trim()},
              ${finding.ruleId.trim()},
              ${finding.severity},
              ${finding.path},
              ${finding.location === null ? null : JSON.stringify(finding.location)}::jsonb,
              ${finding.summary.trim()},
              ${finding.disposition}
            )
          `);
        }
        await tx.execute(sql`
          INSERT INTO kortix.developer_module_trust_attestations (
            run_id, account_id, attestation_digest, subject_artifact_digest,
            predicate_type, policy_digest, result, sbom_digest, dsse_envelope, issuer
          ) VALUES (
            ${input.runId},
            ${stringValue(locked, 'accountId', 'account_id')},
            ${input.attestation.attestationDigest},
            ${input.attestation.subjectArtifactDigest},
            ${input.attestation.predicateType},
            ${input.attestation.policyDigest},
            ${input.attestation.result},
            ${input.attestation.sbomDigest},
            ${JSON.stringify(input.attestation.dsseEnvelope)}::jsonb,
            ${input.attestation.issuer}
          )
        `);
        const finishedAt = current.toISOString();
        const updatedResult = await tx.execute(sql`
          UPDATE kortix.developer_module_verification_runs
          SET state = ${input.result},
              terminal_reason = ${input.terminalReason.trim()},
              sbom_digest = ${input.sbomDigest},
              attestation_digest = ${input.attestation.attestationDigest},
              resource_summary = ${JSON.stringify(input.resourceSummary)}::jsonb,
              lease_owner = NULL,
              lease_token_hash = NULL,
              lease_expires_at = NULL,
              finished_at = ${finishedAt},
              updated_at = ${finishedAt}
          WHERE run_id = ${input.runId}
          RETURNING ${RUN_RETURNING}
        `);
        const updated = rows(updatedResult)[0];
        if (!updated) fail('DEVELOPER_VERIFICATION_LEASE_LOST', 409);
        if (input.result === 'passed') {
          const releaseResult = await tx.execute(sql`
            UPDATE kortix.developer_module_releases
            SET sbom_digest = ${input.sbomDigest},
                trust_attestation_digest = ${input.attestation.attestationDigest},
                verification_policy_digest = ${input.policyDigest},
                updated_at = ${finishedAt}
            WHERE release_id = ${stringValue(locked, 'releaseId', 'release_id')}
              AND account_id = ${stringValue(locked, 'accountId', 'account_id')}
              AND artifact_id = ${stringValue(locked, 'artifactId', 'artifact_id')}
              AND status NOT IN ('signed', 'published', 'revoked', 'deprecated')
            RETURNING release_id
          `);
          if (rows(releaseResult).length === 0) {
            fail('DEVELOPER_VERIFICATION_CONFLICT', 409);
          }
        }
        await tx.execute(sql`
          UPDATE kortix.developer_module_verification_capabilities
          SET revoked_at = COALESCE(revoked_at, ${finishedAt}),
              updated_at = ${finishedAt}
          WHERE run_id = ${input.runId}
            AND account_id = ${stringValue(locked, 'accountId', 'account_id')}
            AND revoked_at IS NULL
        `);
        return serializeRun(updated);
      });
    },

    async retry(input) {
      for (const candidate of [
        input.policyDigest,
        input.scannerSetDigest,
        input.sandboxProfileDigest,
      ]) {
        validateDigest(candidate);
      }
      const accountPredicate = input.accountId
        ? sql`AND release.account_id = ${input.accountId}`
        : sql``;
      const result = await db.execute(sql`
        INSERT INTO kortix.developer_module_verification_runs (
          release_id, artifact_id, account_id, policy_digest, scanner_set_digest,
          sandbox_profile_digest, attempt, state
        )
        SELECT
          release.release_id,
          release.artifact_id,
          release.account_id,
          ${input.policyDigest},
          ${input.scannerSetDigest},
          ${input.sandboxProfileDigest},
          latest.attempt + 1,
          'queued'
        FROM kortix.developer_module_releases release
        INNER JOIN LATERAL (
          SELECT previous.attempt, previous.state
          FROM kortix.developer_module_verification_runs previous
          WHERE previous.release_id = release.release_id
          ORDER BY previous.attempt DESC
          LIMIT 1
        ) latest ON TRUE
        WHERE release.release_id = ${input.releaseId}
          ${accountPredicate}
          AND latest.state IN ('passed', 'failed', 'inconclusive', 'cancelled')
          AND NOT EXISTS (
            SELECT 1
            FROM kortix.developer_module_verification_runs active
            WHERE active.release_id = release.release_id
              AND active.state IN ('queued', 'running')
          )
        RETURNING ${RUN_RETURNING}
      `);
      const row = rows(result)[0];
      if (!row) {
        const releaseResult = await db.execute(sql`
          SELECT release.release_id
          FROM kortix.developer_module_releases release
          WHERE release.release_id = ${input.releaseId}
            ${accountPredicate}
          LIMIT 1
        `);
        if (rows(releaseResult).length === 0) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
        fail('DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED', 409);
      }
      return serializeRun(row);
    },

    async cancel(input) {
      if (!input.reason.trim() || input.reason.length > 256) {
        fail('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
      }
      const accountPredicate = input.accountId ? sql`AND account_id = ${input.accountId}` : sql``;
      return db.transaction(async (tx) => {
        const finishedAt = now().toISOString();
        const result = await tx.execute(sql`
          UPDATE kortix.developer_module_verification_runs
          SET state = 'cancelled',
              terminal_reason = ${input.reason.trim()},
              lease_owner = NULL,
              lease_token_hash = NULL,
              lease_expires_at = NULL,
              finished_at = ${finishedAt},
              updated_at = ${finishedAt}
          WHERE release_id = ${input.releaseId}
            ${accountPredicate}
            AND state IN ('queued', 'running')
          RETURNING ${RUN_RETURNING}
        `);
        const row = rows(result)[0];
        if (!row) fail('DEVELOPER_VERIFICATION_CANCEL_NOT_ALLOWED', 409);
        await tx.execute(sql`
          UPDATE kortix.developer_module_verification_capabilities
          SET revoked_at = COALESCE(revoked_at, ${finishedAt}),
              updated_at = ${finishedAt}
          WHERE run_id = ${stringValue(row, 'runId', 'run_id')}
            AND account_id = ${stringValue(row, 'accountId', 'account_id')}
            AND revoked_at IS NULL
        `);
        return serializeRun(row);
      });
    },

    getPublisherView(accountId, releaseId) {
      return loadTrustView(db, releaseId, accountId);
    },

    getAdminView(releaseId) {
      return loadTrustView(db, releaseId);
    },
  };
}
