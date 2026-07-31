'use client';

import type {
  DeveloperModuleFindingSeverity,
  DeveloperModuleReviewRequirement,
  DeveloperModuleTrustView,
  DeveloperModuleVerificationAttempt,
} from '@kortix/sdk';
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';

import type { DeveloperModuleTrustGateStatus } from '../model';

const SEVERITIES: readonly DeveloperModuleFindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

const AUTOMATIC_REQUIREMENT_LABELS: Partial<Record<DeveloperModuleReviewRequirement, string>> = {
  source_scan: 'Source scan',
  sandbox_test: 'Sandbox test',
  sdk_contract_test: 'SDK contract test',
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function stateIcon(state: DeveloperModuleVerificationAttempt['state']) {
  if (state === 'passed') return <CheckCircle2 className="size-4 text-emerald-600" />;
  if (state === 'queued' || state === 'running') {
    return <Clock3 className="size-4 text-amber-600" />;
  }
  return <AlertTriangle className="size-4 text-destructive" />;
}

function terminalAttempt(attempt: DeveloperModuleVerificationAttempt | undefined): boolean {
  return Boolean(
    attempt &&
      attempt.state !== 'queued' &&
      attempt.state !== 'running' &&
      attempt.state !== 'passed',
  );
}

function provenanceValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface DeveloperModuleTrustSummaryProps {
  trust: DeveloperModuleTrustView | null;
  gateStatus: DeveloperModuleTrustGateStatus;
  requirements: readonly DeveloperModuleReviewRequirement[];
  canRetry?: boolean;
  retryPending?: boolean;
  showProvenance?: boolean;
  onRetry?: () => void;
}

export function DeveloperModuleTrustSummary({
  trust,
  gateStatus,
  requirements,
  canRetry = false,
  retryPending = false,
  showProvenance = false,
  onRetry,
}: DeveloperModuleTrustSummaryProps) {
  const automaticRequirements = requirements.filter(
    (requirement) => AUTOMATIC_REQUIREMENT_LABELS[requirement],
  );
  const latest = trust?.attempts.at(-1);
  const findings = latest?.findings ?? [];
  const retryAvailable = canRetry && Boolean(onRetry) && terminalAttempt(latest);

  return (
    <section className="space-y-5" aria-label="Automatic trust evidence">
      <div className="flex flex-wrap items-start justify-between gap-3 border-y py-4">
        <div className="flex min-w-0 items-start gap-3">
          {gateStatus.ready ? (
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" />
          ) : (
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
          )}
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Automatic trust</h2>
            <p className="mt-1 text-sm text-muted-foreground">{gateStatus.message}</p>
            {!gateStatus.ready ? (
              <p className="mt-1 text-xs text-muted-foreground">{gateStatus.code}</p>
            ) : null}
          </div>
        </div>
        {retryAvailable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={retryPending}
            onClick={onRetry}
          >
            {retryPending ? <Loading /> : <RefreshCw />}
            {retryPending ? 'Retrying...' : 'Retry verification'}
          </Button>
        ) : null}
      </div>

      {automaticRequirements.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold">Automatic requirements</h3>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {automaticRequirements.map((requirement) => (
              <li
                key={requirement}
                className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
              >
                {latest ? (
                  stateIcon(latest.state)
                ) : (
                  <Clock3 className="size-4 text-muted-foreground" />
                )}
                <span>{AUTOMATIC_REQUIREMENT_LABELS[requirement]}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {latest ? titleCase(latest.state) : 'Waiting'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {trust ? (
        <div className="grid gap-x-6 gap-y-3 border-y py-4 text-xs sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground">Artifact</p>
            <p className="mt-1 break-all font-mono">{trust.artifact.artifact_digest}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Package</p>
            <p className="mt-1 break-words">
              {formatBytes(trust.artifact.size_bytes)} / {trust.artifact.media_type}
            </p>
          </div>
          {latest?.sbom_digest ? (
            <div>
              <p className="text-muted-foreground">SBOM digest</p>
              <p className="mt-1 break-all font-mono">{latest.sbom_digest}</p>
            </div>
          ) : null}
          {latest?.attestation_digest ? (
            <div>
              <p className="text-muted-foreground">Attestation digest</p>
              <p className="mt-1 break-all font-mono">{latest.attestation_digest}</p>
            </div>
          ) : null}
          {latest?.attestation ? (
            <>
              <div>
                <p className="text-muted-foreground">Attestation issuer</p>
                <p className="mt-1 break-words">{latest.attestation.issuer}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Predicate</p>
                <p className="mt-1 break-words">{latest.attestation.predicate_type}</p>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No automatic trust evidence is available.</p>
      )}

      {latest?.terminal_reason ? (
        <div className="rounded-lg border px-3 py-2 text-sm">
          <span className="font-medium">Latest result:</span> {latest.terminal_reason}
        </div>
      ) : null}

      {findings.length > 0 ? (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">Sanitized findings</h3>
          {SEVERITIES.map((severity) => {
            const entries = findings.filter((finding) => finding.severity === severity);
            if (entries.length === 0) return null;
            return (
              <div key={severity}>
                <h4 className="text-xs font-semibold">{titleCase(severity)} findings</h4>
                <ul className="mt-2 space-y-2">
                  {entries.map((finding) => (
                    <li key={finding.finding_id} className="rounded-lg border px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{finding.scanner}</span>
                        <span className="text-xs text-muted-foreground">{finding.rule_id}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {titleCase(finding.disposition)}
                        </span>
                      </div>
                      <p className="mt-1">{finding.summary}</p>
                      {finding.path ? (
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {finding.path}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}

      {showProvenance && trust?.artifact.source_provenance ? (
        <div>
          <h3 className="text-sm font-semibold">Source provenance</h3>
          <dl className="mt-2 grid gap-x-6 gap-y-2 border-y py-3 text-xs sm:grid-cols-2">
            {Object.entries(trust.artifact.source_provenance).map(([key, value]) => (
              <div key={key} className="min-w-0">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="mt-1 break-all">{provenanceValue(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {trust?.attempts.length ? (
        <div>
          <h3 className="text-sm font-semibold">Immutable attempts</h3>
          <ol className="mt-2 space-y-2">
            {trust.attempts.map((attempt) => (
              <li key={attempt.run_id} className="rounded-lg border px-3 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {stateIcon(attempt.state)}
                  <span className="font-medium">Attempt {attempt.attempt}</span>
                  <span className="text-xs text-muted-foreground">{titleCase(attempt.state)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {attempt.finished_at ?? attempt.started_at ?? attempt.created_at}
                  </span>
                </div>
                <dl className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <div>
                    <dt>Policy</dt>
                    <dd className="break-all font-mono">{attempt.policy_digest}</dd>
                  </div>
                  <div>
                    <dt>Scanner set</dt>
                    <dd className="break-all font-mono">{attempt.scanner_set_digest}</dd>
                  </div>
                  <div>
                    <dt>Sandbox profile</dt>
                    <dd className="break-all font-mono">{attempt.sandbox_profile_digest}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
