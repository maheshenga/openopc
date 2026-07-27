use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const RUNTIME_DESCRIPTOR_SCHEMA: &str = include_str!(
    "../../../packages/module-runtime-contracts/schema/openopc.runtime.v1.schema.json"
);
pub const WORK_ENVELOPE_SCHEMA: &str =
    include_str!("../../../packages/module-runtime-contracts/schema/work-envelope.v1.schema.json");
pub const CLAIM_BUNDLE_SCHEMA: &str =
    include_str!("../../../packages/module-runtime-contracts/schema/claim-bundle.v1.schema.json");

pub const MODULE_EXECUTION_INPUT_MAX_BYTES: usize = 262_144;
pub const WASI_RUNTIME_ARTIFACT_MAX_BYTES: u64 = 33_554_432;
pub const RUNTIME_ARTIFACT_FETCH_PATH: &str = "module-runtime/artifacts/fetch";

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("RUNTIME_DESCRIPTOR_INVALID")]
    InvalidRuntimeDescriptor,
    #[error("PROTOCOL_IO_FAILED")]
    Io(#[from] std::io::Error),
    #[error("PROTOCOL_JSON_INVALID")]
    Json(#[from] serde_json::Error),
    #[error("WORK_ENVELOPE_INVALID")]
    InvalidWorkEnvelope,
    #[error("WORK_ENVELOPE_SIGNATURE_INVALID")]
    InvalidSignature,
    #[error("WORK_ENVELOPE_BINDING_DIGEST_INVALID")]
    InvalidBindingDigest,
    #[error("WORK_ENVELOPE_EXPIRED")]
    Expired,
    #[error("RUNNER_CAPABILITY_BINDING_INVALID")]
    InvalidCapabilityBinding,
    #[error("RUNNER_CLAIM_BUNDLE_INVALID")]
    InvalidClaimBundle,
    #[error("RUNNER_DESCRIPTOR_DIGEST_MISMATCH")]
    DescriptorDigestMismatch,
    #[error("RUNNER_INPUT_DIGEST_MISMATCH")]
    InputDigestMismatch,
    #[error("RUNNER_ARTIFACT_DIGEST_MISMATCH")]
    ArtifactDigestMismatch,
    #[error("RUNNER_ARTIFACT_LIMIT")]
    ArtifactLimit,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeDescriptorV1 {
    pub descriptor_version: u8,
    pub runtime: Runtime,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case", tag = "kind")]
pub enum Runtime {
    WasiComponent {
        component: String,
        world: String,
        operation: String,
        imports: Vec<String>,
        limits: RuntimeLimits,
    },
    OciImage {
        image: String,
        command: Vec<String>,
        args: Vec<String>,
        profile: String,
        limits: RuntimeLimits,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeLimits {
    pub cpu_millis: u64,
    pub fuel: u64,
    pub memory_mi_b: u64,
    pub output_bytes: u64,
    pub pids: u64,
    pub wall_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkEnvelopeV1 {
    pub envelope_version: u8,
    pub execution_id: String,
    pub account_id: String,
    pub project_id: String,
    pub installation_id: String,
    pub idempotency_key: String,
    pub install_revision: u32,
    pub release_id: String,
    pub release_digest: String,
    pub consent_revision_id: String,
    pub permission_digest: String,
    pub runtime_descriptor_id: String,
    pub runtime_descriptor_digest: String,
    pub input_digest: String,
    pub runtime_artifact_digest: String,
    pub runtime_artifact_bytes: u64,
    pub runtime_kind: RuntimeKind,
    pub runtime_profile: String,
    pub policy_digest: String,
    pub kill_switch_generation: u32,
    pub execution_deadline: String,
    pub binding_digest: String,
    pub resource_ceilings: WorkEnvelopeResourceCeilingsV1,
    pub lease: WorkEnvelopeLeaseV1,
    pub grants: Vec<WorkEnvelopeGrantV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Hash, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeKind {
    WasiComponent,
    OciImage,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkEnvelopeResourceCeilingsV1 {
    pub cpu_millis: u64,
    pub memory_mi_b: u64,
    pub wall_time_ms: u64,
    pub cost_micro: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkEnvelopeLeaseV1 {
    pub id: String,
    pub generation: u32,
    pub deadline: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkEnvelopeGrantV1 {
    pub id: String,
    pub audience: String,
    pub token_hash: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityAudience {
    Secret,
    Egress,
    Model,
    Desktop,
    PaidCall,
}

impl CapabilityAudience {
    fn envelope_value(self) -> &'static str {
        match self {
            Self::Secret => "openopc:capability/secret",
            Self::Egress => "openopc:capability/egress",
            Self::Model => "openopc:capability/model",
            Self::Desktop => "openopc:capability/desktop",
            Self::PaidCall => "openopc:capability/paid-call",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunnerCapabilityTokenV1 {
    pub grant_id: String,
    pub audience: CapabilityAudience,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunnerClaimResponseV1 {
    pub signed_envelope: String,
    pub capability_tokens: Vec<RunnerCapabilityTokenV1>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunnerClaimBundleV1 {
    pub signed_envelope: String,
    pub capability_tokens: Vec<RunnerCapabilityTokenV1>,
    pub runtime_descriptor: RuntimeDescriptorV1,
    pub input_base64: String,
    pub runtime_artifact: RuntimeArtifactReference,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeArtifactReference {
    pub fetch_path: String,
    pub digest: String,
    pub bytes: u64,
}

pub type RuntimeArtifactReferenceV1 = RuntimeArtifactReference;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedClaim {
    pub envelope: WorkEnvelopeV1,
    pub capability_tokens: Vec<RunnerCapabilityTokenV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedExecutionBundle {
    pub claim: VerifiedClaim,
    pub runtime_descriptor: RuntimeDescriptorV1,
    pub input: Vec<u8>,
    pub runtime_artifact: RuntimeArtifactReference,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedHeader {
    alg: String,
    typ: String,
    kid: String,
    traceparent: String,
}

pub fn parse_runtime_descriptor_file(path: &Path) -> Result<RuntimeDescriptorV1, ProtocolError> {
    parse_runtime_descriptor(&fs::read(path)?)
}

pub fn parse_runtime_descriptor(bytes: &[u8]) -> Result<RuntimeDescriptorV1, ProtocolError> {
    let descriptor: RuntimeDescriptorV1 = serde_json::from_slice(bytes)?;
    if descriptor.descriptor_version != 1 || !valid_runtime(&descriptor.runtime) {
        return Err(ProtocolError::InvalidRuntimeDescriptor);
    }
    Ok(descriptor)
}

pub fn parse_work_envelope_value(value: Value) -> Result<WorkEnvelopeV1, ProtocolError> {
    let envelope: WorkEnvelopeV1 = serde_json::from_value(value)?;
    validate_work_envelope(&envelope)?;
    Ok(envelope)
}

pub fn parse_runner_claim_bundle_value(value: Value) -> Result<RunnerClaimBundleV1, ProtocolError> {
    let bundle: RunnerClaimBundleV1 =
        serde_json::from_value(value).map_err(|_| ProtocolError::InvalidClaimBundle)?;
    let input = URL_SAFE_NO_PAD
        .decode(&bundle.input_base64)
        .map_err(|_| ProtocolError::InvalidClaimBundle)?;
    let unique_grants = bundle
        .capability_tokens
        .iter()
        .map(|token| token.grant_id.as_str())
        .collect::<HashSet<_>>()
        .len()
        == bundle.capability_tokens.len();
    if !valid_compact_signature(&bundle.signed_envelope)
        || bundle.capability_tokens.len() > 64
        || !unique_grants
        || bundle.capability_tokens.iter().any(|token| {
            Uuid::parse_str(&token.grant_id).is_err()
                || token.token.is_empty()
                || token.token.len() > 16_384
        })
        || input.is_empty()
        || input.len() > MODULE_EXECUTION_INPUT_MAX_BYTES
        || URL_SAFE_NO_PAD.encode(input) != bundle.input_base64
        || !valid_runtime(&bundle.runtime_descriptor.runtime)
        || bundle.runtime_descriptor.descriptor_version != 1
        || bundle.runtime_artifact.fetch_path != RUNTIME_ARTIFACT_FETCH_PATH
        || !valid_sha256(&bundle.runtime_artifact.digest)
        || !(1..=WASI_RUNTIME_ARTIFACT_MAX_BYTES).contains(&bundle.runtime_artifact.bytes)
    {
        return Err(ProtocolError::InvalidClaimBundle);
    }
    Ok(bundle)
}

pub fn compute_binding_digest(envelope: &WorkEnvelopeV1) -> Result<String, ProtocolError> {
    let binding = json!({
        "accountId": envelope.account_id,
        "projectId": envelope.project_id,
        "installationId": envelope.installation_id,
        "installRevision": envelope.install_revision,
        "releaseId": envelope.release_id,
        "releaseDigest": envelope.release_digest,
        "consentRevisionId": envelope.consent_revision_id,
        "permissionDigest": envelope.permission_digest,
        "policyDigest": envelope.policy_digest,
        "runtimeDescriptorId": envelope.runtime_descriptor_id,
        "runtimeDescriptorDigest": envelope.runtime_descriptor_digest,
        "inputDigest": envelope.input_digest,
        "runtimeArtifactDigest": envelope.runtime_artifact_digest,
        "runtimeArtifactBytes": envelope.runtime_artifact_bytes,
        "runtimeKind": envelope.runtime_kind,
        "runtimeProfile": envelope.runtime_profile,
        "killSwitchGeneration": envelope.kill_switch_generation,
        "resourceCeilings": envelope.resource_ceilings,
        "deadlineAt": envelope.execution_deadline,
    });
    let canonical = canonical_json_bytes(binding)?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

pub fn verify_claim_bundle(
    bundle: RunnerClaimBundleV1,
    public_key: &VerifyingKey,
    expected_key_id: &str,
    now: DateTime<Utc>,
) -> Result<VerifiedExecutionBundle, ProtocolError> {
    if !(1..=WASI_RUNTIME_ARTIFACT_MAX_BYTES).contains(&bundle.runtime_artifact.bytes) {
        return Err(ProtocolError::ArtifactLimit);
    }
    if bundle.runtime_artifact.fetch_path != RUNTIME_ARTIFACT_FETCH_PATH
        || !valid_sha256(&bundle.runtime_artifact.digest)
    {
        return Err(ProtocolError::InvalidClaimBundle);
    }

    let claim = verify_claim_response(
        RunnerClaimResponseV1 {
            signed_envelope: bundle.signed_envelope,
            capability_tokens: bundle.capability_tokens,
        },
        public_key,
        expected_key_id,
        now,
    )?;

    let descriptor_bytes = canonical_json_bytes(
        serde_json::to_value(&bundle.runtime_descriptor)
            .map_err(|_| ProtocolError::InvalidRuntimeDescriptor)?,
    )?;
    let descriptor_digest = format!("sha256:{:x}", Sha256::digest(&descriptor_bytes));
    let runtime_kind_matches = matches!(
        (
            &bundle.runtime_descriptor.runtime,
            claim.envelope.runtime_kind
        ),
        (Runtime::WasiComponent { .. }, RuntimeKind::WasiComponent)
            | (Runtime::OciImage { .. }, RuntimeKind::OciImage)
    );
    if descriptor_digest != claim.envelope.runtime_descriptor_digest || !runtime_kind_matches {
        return Err(ProtocolError::DescriptorDigestMismatch);
    }

    let input = URL_SAFE_NO_PAD
        .decode(&bundle.input_base64)
        .map_err(|_| ProtocolError::InputDigestMismatch)?;
    if input.is_empty()
        || input.len() > MODULE_EXECUTION_INPUT_MAX_BYTES
        || URL_SAFE_NO_PAD.encode(&input) != bundle.input_base64
    {
        return Err(ProtocolError::InputDigestMismatch);
    }
    let parsed_input: Value =
        serde_json::from_slice(&input).map_err(|_| ProtocolError::InputDigestMismatch)?;
    if canonical_json_bytes(parsed_input)? != input
        || format!("sha256:{:x}", Sha256::digest(&input)) != claim.envelope.input_digest
    {
        return Err(ProtocolError::InputDigestMismatch);
    }

    if bundle.runtime_artifact.digest != claim.envelope.runtime_artifact_digest
        || bundle.runtime_artifact.bytes != claim.envelope.runtime_artifact_bytes
    {
        return Err(ProtocolError::ArtifactDigestMismatch);
    }

    Ok(VerifiedExecutionBundle {
        claim,
        runtime_descriptor: bundle.runtime_descriptor,
        input,
        runtime_artifact: bundle.runtime_artifact,
    })
}

pub fn verify_claim_response(
    response: RunnerClaimResponseV1,
    public_key: &VerifyingKey,
    expected_key_id: &str,
    now: DateTime<Utc>,
) -> Result<VerifiedClaim, ProtocolError> {
    let mut parts = response.signed_envelope.split('.');
    let (Some(protected), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ProtocolError::InvalidSignature);
    };
    let header: ProtectedHeader = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(protected)
            .map_err(|_| ProtocolError::InvalidSignature)?,
    )
    .map_err(|_| ProtocolError::InvalidSignature)?;
    if header.alg != "EdDSA"
        || header.typ != "openopc-work-envelope+jwt"
        || header.kid != expected_key_id
        || !valid_traceparent(&header.traceparent)
    {
        return Err(ProtocolError::InvalidSignature);
    }
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| ProtocolError::InvalidSignature)?;
    let signature =
        Signature::from_slice(&signature).map_err(|_| ProtocolError::InvalidSignature)?;
    public_key
        .verify(format!("{protected}.{payload}").as_bytes(), &signature)
        .map_err(|_| ProtocolError::InvalidSignature)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| ProtocolError::InvalidSignature)?;
    let envelope = parse_work_envelope_value(serde_json::from_slice(&payload)?)?;
    if compute_binding_digest(&envelope)? != envelope.binding_digest {
        return Err(ProtocolError::InvalidBindingDigest);
    }
    let lease_deadline = timestamp(&envelope.lease.deadline)?;
    let execution_deadline = timestamp(&envelope.execution_deadline)?;
    if lease_deadline <= now || execution_deadline <= now || lease_deadline > execution_deadline {
        return Err(ProtocolError::Expired);
    }
    verify_capability_bindings(&envelope.grants, &response.capability_tokens)?;
    Ok(VerifiedClaim {
        envelope,
        capability_tokens: response.capability_tokens,
    })
}

fn verify_capability_bindings(
    grants: &[WorkEnvelopeGrantV1],
    tokens: &[RunnerCapabilityTokenV1],
) -> Result<(), ProtocolError> {
    if grants.len() != tokens.len() {
        return Err(ProtocolError::InvalidCapabilityBinding);
    }
    let tokens_by_grant: HashMap<&str, &RunnerCapabilityTokenV1> = tokens
        .iter()
        .map(|token| (token.grant_id.as_str(), token))
        .collect();
    if tokens_by_grant.len() != tokens.len() {
        return Err(ProtocolError::InvalidCapabilityBinding);
    }
    for grant in grants {
        let token = tokens_by_grant
            .get(grant.id.as_str())
            .ok_or(ProtocolError::InvalidCapabilityBinding)?;
        if token.token.is_empty()
            || token.audience.envelope_value() != grant.audience
            || format!("sha256:{:x}", Sha256::digest(token.token.as_bytes())) != grant.token_hash
        {
            return Err(ProtocolError::InvalidCapabilityBinding);
        }
    }
    Ok(())
}

fn validate_work_envelope(envelope: &WorkEnvelopeV1) -> Result<(), ProtocolError> {
    let uuids = [
        &envelope.execution_id,
        &envelope.account_id,
        &envelope.project_id,
        &envelope.installation_id,
        &envelope.release_id,
        &envelope.consent_revision_id,
        &envelope.runtime_descriptor_id,
        &envelope.lease.id,
    ];
    let digests = [
        &envelope.release_digest,
        &envelope.permission_digest,
        &envelope.runtime_descriptor_digest,
        &envelope.input_digest,
        &envelope.runtime_artifact_digest,
        &envelope.policy_digest,
        &envelope.binding_digest,
    ];
    let grants_valid = envelope.grants.len() <= 64
        && envelope.grants.iter().all(|grant| {
            Uuid::parse_str(&grant.id).is_ok()
                && valid_capability_id(&grant.audience)
                && valid_sha256(&grant.token_hash)
        })
        && has_unique_values(
            &envelope
                .grants
                .iter()
                .map(|grant| grant.id.clone())
                .collect::<Vec<_>>(),
        );
    if envelope.envelope_version != 1
        || uuids.iter().any(|value| Uuid::parse_str(value).is_err())
        || !valid_idempotency_key(&envelope.idempotency_key)
        || !(1..=i32::MAX as u32).contains(&envelope.install_revision)
        || digests.iter().any(|value| !valid_sha256(value))
        || !valid_runtime_profile(&envelope.runtime_profile)
        || envelope.kill_switch_generation > i32::MAX as u32
        || !(1..=WASI_RUNTIME_ARTIFACT_MAX_BYTES).contains(&envelope.runtime_artifact_bytes)
        || timestamp(&envelope.execution_deadline).is_err()
        || !(1..=i32::MAX as u32).contains(&envelope.lease.generation)
        || timestamp(&envelope.lease.deadline).is_err()
        || !(1..=900_000).contains(&envelope.resource_ceilings.cpu_millis)
        || !(16..=4096).contains(&envelope.resource_ceilings.memory_mi_b)
        || !(1..=900_000).contains(&envelope.resource_ceilings.wall_time_ms)
        || envelope.resource_ceilings.cost_micro > i32::MAX as u64
        || !grants_valid
    {
        return Err(ProtocolError::InvalidWorkEnvelope);
    }
    Ok(())
}

fn valid_compact_signature(value: &str) -> bool {
    let segments = value.split('.').collect::<Vec<_>>();
    segments.len() == 3
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
        })
}

fn canonical_json_bytes(value: Value) -> Result<Vec<u8>, ProtocolError> {
    let mut output = Vec::new();
    encode_canonical_json(&value, &mut output)?;
    Ok(output)
}

fn encode_canonical_json(value: &Value, output: &mut Vec<u8>) -> Result<(), ProtocolError> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(true) => output.extend_from_slice(b"true"),
        Value::Bool(false) => output.extend_from_slice(b"false"),
        Value::Number(number) => {
            let number = number
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or(ProtocolError::InvalidClaimBundle)?;
            output.extend_from_slice(ryu_js::Buffer::new().format_finite(number).as_bytes());
        }
        Value::String(value) => output.extend_from_slice(serde_json::to_string(value)?.as_bytes()),
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                encode_canonical_json(value, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            output.push(b'{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                output.extend_from_slice(serde_json::to_string(key)?.as_bytes());
                output.push(b':');
                encode_canonical_json(value, output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

fn timestamp(value: &str) -> Result<DateTime<Utc>, ProtocolError> {
    if !value.contains('T') {
        return Err(ProtocolError::InvalidWorkEnvelope);
    }
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| ProtocolError::InvalidWorkEnvelope)
}

fn valid_traceparent(value: &str) -> bool {
    let parts: Vec<_> = value.split('-').collect();
    parts.len() == 4
        && parts[0] == "00"
        && parts[1].len() == 32
        && parts[2].len() == 16
        && parts[3].len() == 2
        && parts[1..]
            .iter()
            .all(|part| part.chars().all(|character| character.is_ascii_hexdigit()))
        && parts[1].chars().any(|character| character != '0')
        && parts[2].chars().any(|character| character != '0')
}

fn valid_idempotency_key(value: &str) -> bool {
    (8..=255).contains(&value.len())
        && value.starts_with(|character: char| character.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

fn valid_runtime_profile(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.starts_with(|character: char| character.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

fn valid_runtime(runtime: &Runtime) -> bool {
    match runtime {
        Runtime::WasiComponent {
            component,
            world,
            operation,
            imports,
            limits,
        } => {
            valid_relative_path(component)
                && valid_bounded_token(world, 256, |value| {
                    value.is_ascii_alphanumeric() || "_.:/@-".contains(value)
                })
                && valid_bounded_token(operation, 128, |value| {
                    value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-'
                })
                && operation.starts_with(|value: char| value.is_ascii_lowercase())
                && imports.len() <= 64
                && imports.windows(2).all(|pair| pair[0] < pair[1])
                && imports.iter().all(|value| valid_capability_id(value))
                && valid_limits(limits)
        }
        Runtime::OciImage {
            image,
            command,
            args,
            profile,
            limits,
        } => {
            valid_sha256(image)
                && !command.is_empty()
                && command.len() <= 32
                && command
                    .iter()
                    .all(|value| !value.is_empty() && value.len() <= 1024)
                && args.len() <= 128
                && args.iter().all(|value| value.len() <= 4096)
                && valid_bounded_token(profile, 63, |value| {
                    value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-'
                })
                && profile.starts_with(|value: char| value.is_ascii_lowercase())
                && valid_limits(limits)
        }
    }
}

fn valid_limits(limits: &RuntimeLimits) -> bool {
    (1..=900_000).contains(&limits.cpu_millis)
        && (1..=1_000_000_000_000).contains(&limits.fuel)
        && (16..=4096).contains(&limits.memory_mi_b)
        && (1..=67_108_864).contains(&limits.output_bytes)
        && (1..=256).contains(&limits.pids)
        && (1..=900_000).contains(&limits.wall_time_ms)
}

fn valid_relative_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('/')
        || value.as_bytes().get(1) == Some(&b':')
        || value.contains('\\')
        || value.contains("//")
    {
        return false;
    }
    value.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || "._-".contains(value))
    })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
}

fn valid_bounded_token(value: &str, max: usize, predicate: impl Fn(char) -> bool) -> bool {
    !value.is_empty() && value.len() <= max && value.chars().all(predicate)
}

fn valid_capability_id(value: &str) -> bool {
    if value.len() > 384 {
        return false;
    }
    let Some((namespace, remainder)) = value.split_once(':') else {
        return false;
    };
    let Some((package, capability)) = remainder.split_once('/') else {
        return false;
    };
    [namespace, package, capability]
        .iter()
        .all(|part| valid_lower_identifier(part))
}

fn valid_lower_identifier(value: &str) -> bool {
    value.starts_with(|character: char| character.is_ascii_lowercase())
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn has_unique_values(values: &[String]) -> bool {
    let mut seen = HashSet::with_capacity(values.len());
    values.iter().all(|value| seen.insert(value))
}
