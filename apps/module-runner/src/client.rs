use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use ed25519_dalek::VerifyingKey;
use ed25519_dalek::pkcs8::DecodePublicKey;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::{Client, Response, redirect};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::{NamedTempFile, TempPath};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tracing::instrument;
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::config::RunnerConfig;
use crate::evidence::{evidence_digest, sanitize_evidence};
use crate::protocol::{
    ProtocolError, RUNTIME_ARTIFACT_FETCH_PATH, VerifiedClaim, VerifiedExecutionBundle,
    WASI_RUNTIME_ARTIFACT_MAX_BYTES, verify_claim_bundle,
};

const MAX_CONTROL_PLANE_RESPONSE_BYTES: usize = 1_048_576;
const MAX_EVIDENCE_REQUEST_BYTES: usize = 262_144;

#[derive(Clone, Debug, PartialEq)]
pub struct ControlPlaneRequest {
    pub path: String,
    pub runner_id: String,
    pub account_id: String,
    pub body: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlPlaneResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub type TransportFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ControlPlaneResponse, RunnerClientError>> + Send + 'a>>;

pub type ArtifactTransportFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ArtifactFetchResponse, RunnerClientError>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeArtifactFetchRequest {
    pub path: String,
    pub runner_id: String,
    pub account_id: String,
    pub body: Value,
    pub expected_digest: String,
    pub expected_bytes: u64,
    pub max_bytes: u64,
    pub destination: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactFetchResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub digest: Option<String>,
    pub body_digest: Option<String>,
    pub bytes_written: u64,
}

pub trait ControlPlaneTransport: Send + Sync {
    fn post<'a>(&'a self, request: ControlPlaneRequest) -> TransportFuture<'a>;

    fn fetch_to<'a>(
        &'a self,
        _request: RuntimeArtifactFetchRequest,
    ) -> ArtifactTransportFuture<'a> {
        Box::pin(async { Err(RunnerClientError::Transport) })
    }
}

struct ReqwestControlPlaneTransport {
    base_url: Url,
    http: Client,
}

impl ControlPlaneTransport for ReqwestControlPlaneTransport {
    fn post<'a>(&'a self, request: ControlPlaneRequest) -> TransportFuture<'a> {
        Box::pin(async move {
            let url = self
                .base_url
                .join(&request.path)
                .map_err(|_| RunnerClientError::Configuration)?;
            let response = self
                .http
                .post(url)
                .header("x-openopc-runner-id", request.runner_id)
                .header("x-openopc-runner-account-id", request.account_id)
                .json(&request.body)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|_| RunnerClientError::Transport)?;
            let status = response.status().as_u16();
            let body = bounded_body(response).await?;
            Ok(ControlPlaneResponse { status, body })
        })
    }

    fn fetch_to<'a>(&'a self, request: RuntimeArtifactFetchRequest) -> ArtifactTransportFuture<'a> {
        Box::pin(async move {
            let url = self
                .base_url
                .join(&request.path)
                .map_err(|_| RunnerClientError::Configuration)?;
            let mut response = self
                .http
                .post(url)
                .header("x-openopc-runner-id", request.runner_id)
                .header("x-openopc-runner-account-id", request.account_id)
                .json(&request.body)
                .timeout(Duration::from_secs(120))
                .send()
                .await
                .map_err(|_| RunnerClientError::Transport)?;
            let status = response.status().as_u16();
            let content_type = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let content_length = response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            let digest = response
                .headers()
                .get("x-openopc-artifact-sha256")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            if !(200..300).contains(&status) {
                return Ok(ArtifactFetchResponse {
                    status,
                    content_type,
                    content_length,
                    digest,
                    body_digest: None,
                    bytes_written: 0,
                });
            }
            if content_length.is_some_and(|bytes| bytes > request.max_bytes) {
                return Err(RunnerClientError::ArtifactLimit);
            }
            let mut file = tokio::fs::File::create(&request.destination)
                .await
                .map_err(|_| RunnerClientError::ArtifactIo)?;
            let mut hasher = Sha256::new();
            let mut bytes_written = 0_u64;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| RunnerClientError::Transport)?
            {
                bytes_written = bytes_written
                    .checked_add(chunk.len() as u64)
                    .ok_or(RunnerClientError::ArtifactLimit)?;
                if bytes_written > request.max_bytes {
                    return Err(RunnerClientError::ArtifactLimit);
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|_| RunnerClientError::ArtifactIo)?;
                hasher.update(&chunk);
            }
            file.flush()
                .await
                .map_err(|_| RunnerClientError::ArtifactIo)?;
            Ok(ArtifactFetchResponse {
                status,
                content_type,
                content_length,
                digest,
                body_digest: Some(format!("sha256:{:x}", hasher.finalize())),
                bytes_written,
            })
        })
    }
}

#[derive(Clone)]
pub struct RunnerClient {
    runner_id: Uuid,
    account_id: Uuid,
    public_key: VerifyingKey,
    expected_key_id: String,
    transport: Arc<dyn ControlPlaneTransport>,
    finalize_fences: Arc<Mutex<HashMap<String, FinalizeFenceState>>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FinalizeFenceState {
    #[default]
    Available,
    InFlight,
    Acknowledged,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HeartbeatExecutionState {
    AwaitingConfirmation,
    Dispatchable,
    Leased,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatExecution {
    pub execution_id: String,
    pub state: HeartbeatExecutionState,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatLease {
    pub lease_id: String,
    pub execution_id: String,
    pub generation: u32,
    pub deadline_at: String,
    pub released_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatLeaseResponse {
    pub execution: HeartbeatExecution,
    pub lease: HeartbeatLease,
}

#[derive(Clone)]
pub struct RuntimeArtifactClient {
    runner_id: Uuid,
    account_id: Uuid,
    transport: Arc<dyn ControlPlaneTransport>,
}

#[derive(Debug)]
pub struct RuntimeArtifactHandle {
    path: TempPath,
    digest: String,
    bytes: u64,
}

impl RuntimeArtifactHandle {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Clone, Debug)]
pub struct FinalizeInput {
    pub outcome: TerminalOutcome,
    pub evidence_digest: String,
    pub evidence: Value,
    pub usage: Value,
}

#[derive(Debug, Error)]
pub enum RunnerClientError {
    #[error("RUNNER_CLIENT_CONFIGURATION_INVALID")]
    Configuration,
    #[error("RUNNER_CONTROL_PLANE_UNAVAILABLE")]
    Transport,
    #[error("RUNNER_CONTROL_PLANE_STATUS_{0}")]
    Status(u16),
    #[error("RUNNER_CONTROL_PLANE_RESPONSE_TOO_LARGE")]
    ResponseTooLarge,
    #[error("RUNNER_CONTROL_PLANE_RESPONSE_INVALID")]
    InvalidResponse,
    #[error("RUNNER_EVIDENCE_INVALID")]
    InvalidEvidence,
    #[error("RUNNER_FINALIZE_ALREADY_SENT")]
    AlreadyFinalized,
    #[error("RUNNER_FINALIZE_IN_FLIGHT")]
    FinalizeInFlight,
    #[error("RUNNER_ARTIFACT_METADATA_INVALID")]
    ArtifactMetadata,
    #[error("RUNNER_ARTIFACT_LENGTH_MISMATCH")]
    ArtifactLength,
    #[error("RUNNER_ARTIFACT_DIGEST_MISMATCH")]
    ArtifactDigest,
    #[error("RUNNER_ARTIFACT_LIMIT")]
    ArtifactLimit,
    #[error("RUNNER_ARTIFACT_IO_FAILED")]
    ArtifactIo,
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
}

impl RunnerClient {
    pub fn new(config: &RunnerConfig) -> Result<Self, RunnerClientError> {
        let public_key_pem = fs::read_to_string(&config.control_plane_public_key_file)
            .map_err(|_| RunnerClientError::Configuration)?;
        let public_key = VerifyingKey::from_public_key_pem(&public_key_pem)
            .map_err(|_| RunnerClientError::Configuration)?;

        let certificate = Zeroizing::new(
            fs::read(&config.mtls_certificate_file)
                .map_err(|_| RunnerClientError::Configuration)?,
        );
        let private_key = Zeroizing::new(
            fs::read(&config.mtls_private_key_file)
                .map_err(|_| RunnerClientError::Configuration)?,
        );
        let mut identity_pem = Zeroizing::new(Vec::with_capacity(
            certificate.len() + private_key.len() + 1,
        ));
        identity_pem.extend_from_slice(&certificate);
        identity_pem.push(b'\n');
        identity_pem.extend_from_slice(&private_key);
        let identity = reqwest::Identity::from_pem(&identity_pem)
            .map_err(|_| RunnerClientError::Configuration)?;
        let http = Client::builder()
            .https_only(true)
            .identity(identity)
            .redirect(redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .user_agent(format!("openopc-module-runner/{}", config.software_version))
            .build()
            .map_err(|_| RunnerClientError::Configuration)?;
        let mut base_url = config.control_plane_url.clone();
        if !base_url.path().ends_with('/') {
            let path = format!("{}/", base_url.path());
            base_url.set_path(&path);
        }
        Ok(Self::with_transport(
            config.runner_id,
            config.account_id,
            public_key,
            config.control_plane_key_id.clone(),
            Arc::new(ReqwestControlPlaneTransport { base_url, http }),
        ))
    }

    pub fn with_transport(
        runner_id: Uuid,
        account_id: Uuid,
        public_key: VerifyingKey,
        expected_key_id: String,
        transport: Arc<dyn ControlPlaneTransport>,
    ) -> Self {
        Self {
            runner_id,
            account_id,
            public_key,
            expected_key_id,
            transport,
            finalize_fences: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[instrument(skip(self, attestation_digest), fields(software_version))]
    pub async fn heartbeat_node(
        &self,
        software_version: &str,
        attestation_digest: &str,
    ) -> Result<Value, RunnerClientError> {
        if software_version.is_empty()
            || software_version.len() > 128
            || software_version.chars().any(char::is_control)
            || !valid_sha256(attestation_digest)
        {
            return Err(RunnerClientError::Configuration);
        }
        self.post_json(
            "module-runtime/runners/heartbeat",
            json!({
                "softwareVersion": software_version,
                "attestationDigest": attestation_digest,
            }),
        )
        .await
    }

    pub async fn claim_next(&self) -> Result<Option<VerifiedExecutionBundle>, RunnerClientError> {
        self.claim_next_at(Utc::now()).await
    }

    #[instrument(skip(self))]
    pub async fn claim_next_at(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<VerifiedExecutionBundle>, RunnerClientError> {
        let response = self.send("module-runtime/claims/next", json!({})).await?;
        if response.status == 204 {
            return Ok(None);
        }
        if response.status != 200 {
            return Err(RunnerClientError::Status(response.status));
        }
        let value = serde_json::from_slice(&response.body)
            .map_err(|_| RunnerClientError::InvalidResponse)?;
        let bundle = crate::protocol::parse_runner_claim_bundle_value(value)?;
        verify_claim_bundle(bundle, &self.public_key, &self.expected_key_id, now)
            .map(Some)
            .map_err(Into::into)
    }

    #[instrument(
        skip(self, claim),
        fields(execution_id = %claim.envelope.execution_id, lease_generation = claim.envelope.lease.generation)
    )]
    pub async fn heartbeat(
        &self,
        claim: &VerifiedClaim,
    ) -> Result<HeartbeatLeaseResponse, RunnerClientError> {
        let response = self
            .send("module-runtime/leases/heartbeat", lease_coordinates(claim))
            .await?;
        ensure_success(response.status)?;
        let heartbeat: HeartbeatLeaseResponse = serde_json::from_slice(&response.body)
            .map_err(|_| RunnerClientError::InvalidResponse)?;
        if heartbeat.execution.execution_id != claim.envelope.execution_id
            || heartbeat.lease.execution_id != claim.envelope.execution_id
            || heartbeat.lease.lease_id != claim.envelope.lease.id
            || heartbeat.lease.generation != claim.envelope.lease.generation
            || DateTime::parse_from_rfc3339(&heartbeat.lease.deadline_at).is_err()
            || heartbeat
                .lease
                .released_at
                .as_deref()
                .is_some_and(|released_at| DateTime::parse_from_rfc3339(released_at).is_err())
        {
            return Err(RunnerClientError::InvalidResponse);
        }
        Ok(heartbeat)
    }

    #[instrument(
        skip(self, claim, evidence),
        fields(execution_id = %claim.envelope.execution_id, event_type)
    )]
    pub async fn append_evidence(
        &self,
        claim: &VerifiedClaim,
        event_type: &str,
        evidence: Value,
    ) -> Result<Value, RunnerClientError> {
        if !valid_event_type(event_type) || !evidence.is_object() {
            return Err(RunnerClientError::InvalidEvidence);
        }
        let evidence =
            sanitize_evidence(evidence).map_err(|_| RunnerClientError::InvalidEvidence)?;
        let mut body = lease_coordinates(claim);
        body["eventType"] = Value::String(event_type.to_owned());
        body["evidence"] = evidence;
        ensure_evidence_size(&body)?;
        self.post_json("module-runtime/evidence", body).await
    }

    #[instrument(
        skip(self, claim, input),
        fields(execution_id = %claim.envelope.execution_id, lease_generation = claim.envelope.lease.generation)
    )]
    pub async fn finalize(
        &self,
        claim: &VerifiedClaim,
        input: FinalizeInput,
    ) -> Result<Value, RunnerClientError> {
        if !input.evidence.is_object() || !input.usage.is_object() {
            return Err(RunnerClientError::InvalidEvidence);
        }
        let evidence =
            sanitize_evidence(input.evidence).map_err(|_| RunnerClientError::InvalidEvidence)?;
        let usage =
            sanitize_evidence(input.usage).map_err(|_| RunnerClientError::InvalidEvidence)?;
        let computed_digest =
            evidence_digest(&evidence).map_err(|_| RunnerClientError::InvalidEvidence)?;
        if !valid_sha256(&input.evidence_digest) || input.evidence_digest != computed_digest {
            return Err(RunnerClientError::InvalidEvidence);
        }
        let mut body = lease_coordinates(claim);
        body["outcome"] =
            serde_json::to_value(input.outcome).map_err(|_| RunnerClientError::InvalidEvidence)?;
        body["evidenceDigest"] = Value::String(input.evidence_digest);
        body["evidence"] = evidence;
        body["usage"] = usage;
        ensure_evidence_size(&body)?;
        let fence = format!(
            "{}:{}:{}",
            claim.envelope.execution_id, claim.envelope.lease.id, claim.envelope.lease.generation
        );
        {
            let mut fences = self
                .finalize_fences
                .lock()
                .map_err(|_| RunnerClientError::AlreadyFinalized)?;
            match fences.get(&fence).copied().unwrap_or_default() {
                FinalizeFenceState::Available => {
                    fences.insert(fence.clone(), FinalizeFenceState::InFlight);
                }
                FinalizeFenceState::InFlight => {
                    return Err(RunnerClientError::FinalizeInFlight);
                }
                FinalizeFenceState::Acknowledged => {
                    return Err(RunnerClientError::AlreadyFinalized);
                }
            }
        }
        let response = self.send("module-runtime/finalize", body).await;
        match response {
            Err(error) => {
                self.set_finalize_fence_state(&fence, FinalizeFenceState::Available)?;
                Err(error)
            }
            Ok(response) if (500..600).contains(&response.status) => {
                self.set_finalize_fence_state(&fence, FinalizeFenceState::Available)?;
                Err(RunnerClientError::Status(response.status))
            }
            Ok(response) => {
                self.set_finalize_fence_state(&fence, FinalizeFenceState::Acknowledged)?;
                ensure_success(response.status)?;
                serde_json::from_slice(&response.body)
                    .map_err(|_| RunnerClientError::InvalidResponse)
            }
        }
    }

    pub fn finalize_fence_state(&self, claim: &VerifiedClaim) -> FinalizeFenceState {
        let fence = finalize_fence_key(claim);
        self.finalize_fences
            .lock()
            .map(|fences| fences.get(&fence).copied().unwrap_or_default())
            .unwrap_or(FinalizeFenceState::Acknowledged)
    }

    fn set_finalize_fence_state(
        &self,
        fence: &str,
        state: FinalizeFenceState,
    ) -> Result<(), RunnerClientError> {
        self.finalize_fences
            .lock()
            .map_err(|_| RunnerClientError::AlreadyFinalized)?
            .insert(fence.to_owned(), state);
        Ok(())
    }

    async fn post_json(&self, path: &str, body: Value) -> Result<Value, RunnerClientError> {
        let response = self.send(path, body).await?;
        ensure_success(response.status)?;
        serde_json::from_slice(&response.body).map_err(|_| RunnerClientError::InvalidResponse)
    }

    async fn send(
        &self,
        path: &str,
        body: Value,
    ) -> Result<ControlPlaneResponse, RunnerClientError> {
        self.transport
            .post(ControlPlaneRequest {
                path: path.to_owned(),
                runner_id: self.runner_id.to_string(),
                account_id: self.account_id.to_string(),
                body,
            })
            .await
    }
}

impl RuntimeArtifactClient {
    pub fn with_transport(
        runner_id: Uuid,
        account_id: Uuid,
        transport: Arc<dyn ControlPlaneTransport>,
    ) -> Self {
        Self {
            runner_id,
            account_id,
            transport,
        }
    }

    #[instrument(
        skip(self, bundle),
        fields(
            execution_id = %bundle.claim.envelope.execution_id,
            lease_generation = bundle.claim.envelope.lease.generation,
            artifact_bytes = bundle.runtime_artifact.bytes,
        )
    )]
    pub async fn fetch(
        &self,
        bundle: &VerifiedExecutionBundle,
    ) -> Result<RuntimeArtifactHandle, RunnerClientError> {
        let artifact = &bundle.runtime_artifact;
        if artifact.bytes == 0 || artifact.bytes > WASI_RUNTIME_ARTIFACT_MAX_BYTES {
            return Err(RunnerClientError::ArtifactLimit);
        }
        if artifact.fetch_path != RUNTIME_ARTIFACT_FETCH_PATH || !valid_sha256(&artifact.digest) {
            return Err(RunnerClientError::ArtifactMetadata);
        }

        let path = NamedTempFile::new()
            .map_err(|_| RunnerClientError::ArtifactIo)?
            .into_temp_path();
        let destination = path.to_path_buf();
        let response = self
            .transport
            .fetch_to(RuntimeArtifactFetchRequest {
                path: artifact.fetch_path.clone(),
                runner_id: self.runner_id.to_string(),
                account_id: self.account_id.to_string(),
                body: lease_coordinates(&bundle.claim),
                expected_digest: artifact.digest.clone(),
                expected_bytes: artifact.bytes,
                max_bytes: artifact.bytes,
                destination,
            })
            .await?;
        ensure_success(response.status)?;
        if response.content_type.as_deref() != Some("application/wasm")
            || response.digest.as_deref() != Some(artifact.digest.as_str())
        {
            return Err(RunnerClientError::ArtifactMetadata);
        }
        if response.content_length != Some(artifact.bytes)
            || response.bytes_written != artifact.bytes
            || fs::metadata(&path)
                .map_err(|_| RunnerClientError::ArtifactIo)?
                .len()
                != artifact.bytes
        {
            return Err(RunnerClientError::ArtifactLength);
        }
        if response.body_digest.as_deref() != Some(artifact.digest.as_str()) {
            return Err(RunnerClientError::ArtifactDigest);
        }

        Ok(RuntimeArtifactHandle {
            path,
            digest: artifact.digest.clone(),
            bytes: artifact.bytes,
        })
    }
}

async fn bounded_body(mut response: Response) -> Result<Vec<u8>, RunnerClientError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CONTROL_PLANE_RESPONSE_BYTES as u64)
    {
        return Err(RunnerClientError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RunnerClientError::Transport)?
    {
        if body.len() + chunk.len() > MAX_CONTROL_PLANE_RESPONSE_BYTES {
            return Err(RunnerClientError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn ensure_success(status: u16) -> Result<(), RunnerClientError> {
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(RunnerClientError::Status(status))
    }
}

fn ensure_evidence_size(body: &Value) -> Result<(), RunnerClientError> {
    if serde_json::to_vec(body)
        .map_err(|_| RunnerClientError::InvalidEvidence)?
        .len()
        > MAX_EVIDENCE_REQUEST_BYTES
    {
        return Err(RunnerClientError::InvalidEvidence);
    }
    Ok(())
}

fn lease_coordinates(claim: &VerifiedClaim) -> Value {
    json!({
        "projectId": claim.envelope.project_id,
        "executionId": claim.envelope.execution_id,
        "leaseId": claim.envelope.lease.id,
        "generation": claim.envelope.lease.generation,
    })
}

fn finalize_fence_key(claim: &VerifiedClaim) -> String {
    format!(
        "{}:{}:{}",
        claim.envelope.execution_id, claim.envelope.lease.id, claim.envelope.lease.generation
    )
}

fn valid_event_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.starts_with(|character: char| character.is_ascii_lowercase())
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}
