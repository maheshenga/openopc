import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface DeveloperModuleValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface DeveloperModuleValidationResult {
  valid: boolean;
  issues: DeveloperModuleValidationIssue[];
}

export type DeveloperModuleDigest = `sha256:${string}`;

export interface DeveloperModuleArtifact {
  artifact_id: string;
  account_id: string;
  publisher_id: string;
  artifact_digest: DeveloperModuleDigest;
  envelope_digest: DeveloperModuleDigest;
  media_type: string;
  size_bytes: number;
  item_snapshot: Record<string, unknown>;
  source_provenance: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
}

export interface DeveloperModuleArtifactUploadTicket {
  upload_id: string;
  state: 'created';
  expected_digest: DeveloperModuleDigest;
  expected_size: number;
  upload_url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export type DeveloperModuleVerificationState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'cancelled';

export type DeveloperModuleFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface DeveloperModuleVerificationRun {
  run_id: string;
  release_id: string;
  artifact_id: string;
  account_id: string;
  policy_digest: DeveloperModuleDigest;
  scanner_set_digest: DeveloperModuleDigest;
  sandbox_profile_digest: DeveloperModuleDigest;
  attempt: number;
  state: DeveloperModuleVerificationState;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  terminal_reason: string | null;
  sbom_digest: DeveloperModuleDigest | null;
  attestation_digest: DeveloperModuleDigest | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeveloperModuleVerificationFinding {
  finding_id: string;
  fingerprint: DeveloperModuleDigest;
  scanner: string;
  rule_id: string;
  severity: DeveloperModuleFindingSeverity;
  path: string | null;
  location: Record<string, unknown> | null;
  summary: string;
  disposition: 'blocking' | 'observed';
  created_at: string;
}

export interface DeveloperModuleTrustAttestation {
  attestation_digest: DeveloperModuleDigest;
  subject_artifact_digest: DeveloperModuleDigest;
  predicate_type: string;
  policy_digest: DeveloperModuleDigest;
  result: Exclude<DeveloperModuleVerificationState, 'queued' | 'running'>;
  sbom_digest: DeveloperModuleDigest;
  issuer: string;
  created_at: string;
}

export interface DeveloperModuleVerificationAttempt {
  run_id: string;
  attempt: number;
  state: DeveloperModuleVerificationState;
  policy_digest: DeveloperModuleDigest;
  scanner_set_digest: DeveloperModuleDigest;
  sandbox_profile_digest: DeveloperModuleDigest;
  terminal_reason: string | null;
  sbom_digest: DeveloperModuleDigest | null;
  attestation_digest: DeveloperModuleDigest | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  findings: DeveloperModuleVerificationFinding[];
  attestation: DeveloperModuleTrustAttestation | null;
}

export interface DeveloperModuleTrustView {
  release_id: string;
  account_id: string;
  artifact: Pick<
    DeveloperModuleArtifact,
    | 'artifact_id'
    | 'artifact_digest'
    | 'media_type'
    | 'size_bytes'
    | 'source_provenance'
    | 'created_at'
  >;
  attempts: DeveloperModuleVerificationAttempt[];
}

export type DeveloperModuleReleaseStatus =
  | 'validated'
  | 'review_pending'
  | 'changes_requested'
  | 'approved'
  | 'signed'
  | 'published'
  | 'revoked'
  | 'deprecated';

export type DeveloperModuleReviewRequirement =
  | 'manifest_review'
  | 'source_scan'
  | 'sandbox_test'
  | 'permission_review'
  | 'desktop_security_review'
  | 'human_review';

export interface DeveloperModuleRelease {
  release_id: string;
  account_id: string;
  item_name: string;
  publisher_id: string;
  module_id: string;
  module_version: string;
  manifest: Record<string, unknown>;
  manifest_digest: string;
  artifact_id: string | null;
  artifact_digest: DeveloperModuleDigest | null;
  sbom_digest: DeveloperModuleDigest | null;
  trust_attestation_digest: DeveloperModuleDigest | null;
  verification_policy_digest: DeveloperModuleDigest | null;
  review_requirements: DeveloperModuleReviewRequirement[];
  status: DeveloperModuleReleaseStatus;
  review_revision: number;
  signature_algorithm: 'ed25519' | null;
  signature_key_id: string | null;
  signature: `base64url:${string}` | null;
  signature_payload_digest: `sha256:${string}` | null;
  signed_at: string | null;
  published_at: string | null;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DeveloperModuleReleaseSubmission {
  created: boolean;
  release: DeveloperModuleRelease;
}

export interface DeveloperModuleReleaseList {
  releases: DeveloperModuleRelease[];
}

export type DeveloperModuleReviewAction =
  | 'submit'
  | 'resubmit'
  | 'request_changes'
  | 'approve'
  | 'revoke';

export type DeveloperModuleReviewActorKind = 'publisher' | 'platform_admin';

export type DeveloperModuleHumanReviewRequirement = Exclude<
  DeveloperModuleReviewRequirement,
  'source_scan' | 'sandbox_test'
>;

export interface DeveloperModuleHumanReviewEvidence {
  requirement: DeveloperModuleHumanReviewRequirement;
  outcome: 'passed';
  method: 'manual';
  summary: string;
  observed_at: string;
}

export interface DeveloperModuleAutomaticReviewEvidence {
  requirement: 'source_scan' | 'sandbox_test';
  outcome: 'passed';
  method: 'system_attestation';
  run_id: string;
  evidence_digest: DeveloperModuleDigest;
  policy_digest: DeveloperModuleDigest;
}

export type DeveloperModuleReviewEvidence =
  | DeveloperModuleHumanReviewEvidence
  | DeveloperModuleAutomaticReviewEvidence;

export interface DeveloperModuleReviewEvent {
  review_event_id: string;
  release_id: string;
  account_id: string;
  sequence: number;
  action: DeveloperModuleReviewAction;
  from_status: DeveloperModuleReleaseStatus;
  to_status: DeveloperModuleReleaseStatus;
  actor_user_id: string;
  actor_kind: DeveloperModuleReviewActorKind;
  reason: string | null;
  evidence: DeveloperModuleReviewEvidence[];
  created_at: string;
}

export interface DeveloperModuleReviewTransition {
  release: DeveloperModuleRelease;
  event: DeveloperModuleReviewEvent;
}

export interface DeveloperModuleReviewHistory {
  history: DeveloperModuleReviewEvent[];
}

export interface RequestDeveloperModuleReviewInput extends DeveloperModuleReleaseAccountOptions {
  expectedStatus: 'validated' | 'changes_requested';
  expectedRevision: number;
  reason?: string;
}

export interface DeveloperModuleReleaseAccountOptions {
  accountId?: string;
}

export interface SubmitDeveloperModuleReleaseInput extends DeveloperModuleReleaseAccountOptions {
  artifactId: string;
}

export interface CreateDeveloperModuleArtifactUploadInput
  extends DeveloperModuleReleaseAccountOptions {
  publisherId: string;
  expectedSize: number;
  expectedDigest: DeveloperModuleDigest;
}

export interface ListDeveloperModuleReleasesOptions extends DeveloperModuleReleaseAccountOptions {
  limit?: number;
}

/** Validate one registry:module item without publishing or persisting it. */
export async function validateDeveloperModule(
  item: Record<string, unknown>,
): Promise<DeveloperModuleValidationResult> {
  return unwrap(
    await backendApi.post<DeveloperModuleValidationResult>('/developer/modules/validate', item),
    'Failed to validate developer module',
  );
}

function releaseQuery(options?: ListDeveloperModuleReleasesOptions): string {
  const search = new URLSearchParams();
  if (options?.accountId) search.set('account_id', options.accountId);
  if (options?.limit !== undefined) search.set('limit', String(options.limit));
  const query = search.toString();
  return query ? `?${query}` : '';
}

/** Create a canonical artifact for one declarative registry item. */
export async function createDeclarativeDeveloperModuleArtifact(
  item: Record<string, unknown>,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleArtifact> {
  return unwrap(
    await backendApi.post<DeveloperModuleArtifact>('/developer/modules/artifacts/declarative', {
      ...(options?.accountId ? { account_id: options.accountId } : {}),
      item,
    }),
    'Failed to create developer module artifact',
  );
}

/** Request a bounded presigned upload for one packaged module artifact. */
export async function createDeveloperModuleArtifactUpload(
  input: CreateDeveloperModuleArtifactUploadInput,
): Promise<DeveloperModuleArtifactUploadTicket> {
  return unwrap(
    await backendApi.post<DeveloperModuleArtifactUploadTicket>(
      '/developer/modules/artifact-uploads',
      {
        ...(input.accountId ? { account_id: input.accountId } : {}),
        publisher_id: input.publisherId,
        expected_size: input.expectedSize,
        expected_digest: input.expectedDigest,
      },
    ),
    'Failed to create developer module artifact upload',
  );
}

/** Finalize an uploaded artifact after the server verifies its bytes and digest. */
export async function finalizeDeveloperModuleArtifactUpload(
  uploadId: string,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleArtifact> {
  return unwrap(
    await backendApi.post<DeveloperModuleArtifact>(
      `/developer/modules/artifact-uploads/${encodeURIComponent(uploadId)}/finalize`,
      options?.accountId ? { account_id: options.accountId } : {},
    ),
    'Failed to finalize developer module artifact upload',
  );
}

/** Cancel one unfinished artifact upload without exposing its storage key. */
export async function cancelDeveloperModuleArtifactUpload(
  uploadId: string,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<void> {
  unwrap(
    await backendApi.delete<Blob>(
      `/developer/modules/artifact-uploads/${encodeURIComponent(uploadId)}${releaseQuery(options)}`,
    ),
    'Failed to cancel developer module artifact upload',
  );
}

/** Read safe account-scoped artifact metadata. */
export async function getDeveloperModuleArtifact(
  artifactId: string,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleArtifact> {
  return unwrap(
    await backendApi.get<DeveloperModuleArtifact>(
      `/developer/modules/artifacts/${encodeURIComponent(artifactId)}${releaseQuery(options)}`,
    ),
    'Failed to read developer module artifact',
  );
}

/** Persist one immutable release bound to a server-owned artifact. */
export async function submitDeveloperModuleRelease(
  input: SubmitDeveloperModuleReleaseInput,
): Promise<DeveloperModuleReleaseSubmission> {
  return unwrap(
    await backendApi.post<DeveloperModuleReleaseSubmission>('/developer/modules/releases', {
      ...(input.accountId ? { account_id: input.accountId } : {}),
      artifact_id: input.artifactId,
    }),
    'Failed to submit developer module release',
  );
}

/** List validated and later-lifecycle releases visible to one account. */
export async function listDeveloperModuleReleases(
  options?: ListDeveloperModuleReleasesOptions,
): Promise<DeveloperModuleReleaseList> {
  return unwrap(
    await backendApi.get<DeveloperModuleReleaseList>(
      `/developer/modules/releases${releaseQuery(options)}`,
    ),
    'Failed to list developer module releases',
  );
}

/** Read one release through the same account isolation boundary as list. */
export async function getDeveloperModuleRelease(
  releaseId: string,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleRelease> {
  return unwrap(
    await backendApi.get<DeveloperModuleRelease>(
      `/developer/modules/releases/${encodeURIComponent(releaseId)}${releaseQuery(options)}`,
    ),
    'Failed to read developer module release',
  );
}

/** Request initial review or resubmit a changes-requested release. */
export async function requestDeveloperModuleReview(
  releaseId: string,
  input: RequestDeveloperModuleReviewInput,
): Promise<DeveloperModuleReviewTransition> {
  return unwrap(
    await backendApi.post<DeveloperModuleReviewTransition>(
      `/developer/modules/releases/${encodeURIComponent(releaseId)}/review-requests`,
      {
        ...(input.accountId ? { account_id: input.accountId } : {}),
        expected_status: input.expectedStatus,
        expected_revision: input.expectedRevision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    ),
    'Failed to request developer module review',
  );
}

/** Read chronological immutable review history through the publisher account boundary. */
export async function getDeveloperModuleReviewHistory(
  releaseId: string,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleReviewHistory> {
  return unwrap(
    await backendApi.get<DeveloperModuleReviewHistory>(
      `/developer/modules/releases/${encodeURIComponent(releaseId)}/review-history${releaseQuery(options)}`,
    ),
    'Failed to read developer module review history',
  );
}

/** Read sanitized immutable verification attempts for one release. */
export async function getDeveloperModuleTrust(
  releaseId: string,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleTrustView> {
  return unwrap(
    await backendApi.get<DeveloperModuleTrustView>(
      `/developer/modules/releases/${encodeURIComponent(releaseId)}/trust${releaseQuery(options)}`,
    ),
    'Failed to read developer module trust evidence',
  );
}

/** Retry the latest terminal verification attempt through the publisher boundary. */
export async function retryDeveloperModuleVerification(
  releaseId: string,
  options?: DeveloperModuleReleaseAccountOptions,
): Promise<DeveloperModuleVerificationRun> {
  return unwrap(
    await backendApi.post<DeveloperModuleVerificationRun>(
      `/developer/modules/releases/${encodeURIComponent(releaseId)}/verification-retries`,
      options?.accountId ? { account_id: options.accountId } : {},
    ),
    'Failed to retry developer module verification',
  );
}
