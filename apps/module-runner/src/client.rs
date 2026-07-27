use std::collections::HashSet;
use std::fs;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use ed25519_dalek::VerifyingKey;
use ed25519_dalek::pkcs8::DecodePublicKey;
use reqwest::{Client, Response};
use serde::Serialize;
use serde_json::{Value, json};
use thiserror::Error;
use tracing::instrument;
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::config::RunnerConfig;
use crate::evidence::{evidence_digest, sanitize_evidence};
use crate::protocol::{ProtocolError, RunnerClaimResponseV1, VerifiedClaim, verify_claim_response};

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

pub trait ControlPlaneTransport: Send + Sync {
    fn post<'a>(&'a self, request: ControlPlaneRequest) -> TransportFuture<'a>;
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
                .send()
                .await
                .map_err(|_| RunnerClientError::Transport)?;
            let status = response.status().as_u16();
            let body = bounded_body(response).await?;
            Ok(ControlPlaneResponse { status, body })
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
    finalized: Arc<Mutex<HashSet<String>>>,
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
            finalized: Arc::new(Mutex::new(HashSet::new())),
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

    pub async fn claim(
        &self,
        execution_id: Uuid,
    ) -> Result<Option<VerifiedClaim>, RunnerClientError> {
        self.claim_at(execution_id, Utc::now()).await
    }

    #[instrument(skip(self), fields(execution_id = %execution_id))]
    pub async fn claim_at(
        &self,
        execution_id: Uuid,
        now: DateTime<Utc>,
    ) -> Result<Option<VerifiedClaim>, RunnerClientError> {
        let response = self
            .send(
                "module-runtime/claims",
                json!({ "executionId": execution_id }),
            )
            .await?;
        if response.status == 404 {
            return Ok(None);
        }
        ensure_success(response.status)?;
        let response: RunnerClaimResponseV1 = serde_json::from_slice(&response.body)
            .map_err(|_| RunnerClientError::InvalidResponse)?;
        verify_claim_response(response, &self.public_key, &self.expected_key_id, now)
            .map(Some)
            .map_err(Into::into)
    }

    #[instrument(
        skip(self, claim),
        fields(execution_id = %claim.envelope.execution_id, lease_generation = claim.envelope.lease.generation)
    )]
    pub async fn heartbeat(&self, claim: &VerifiedClaim) -> Result<Value, RunnerClientError> {
        self.post_json("module-runtime/leases/heartbeat", lease_coordinates(claim))
            .await
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
            let mut finalized = self
                .finalized
                .lock()
                .map_err(|_| RunnerClientError::AlreadyFinalized)?;
            if !finalized.insert(fence) {
                return Err(RunnerClientError::AlreadyFinalized);
            }
        }
        self.post_json("module-runtime/finalize", body).await
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
