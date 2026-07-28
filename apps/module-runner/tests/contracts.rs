use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{TimeZone, Utc};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::sync::Notify;
use tower::ServiceExt;
use uuid::Uuid;

use openopc_module_runner::{client, config, evidence, protocol, service};

fn fixture(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/module-runtime-contracts/fixtures")
        .join(relative)
}

#[test]
fn parses_every_typescript_golden_fixture_and_rejects_invalid_ones() {
    assert!(protocol::RUNTIME_DESCRIPTOR_SCHEMA.contains("openopc.runtime.v1"));
    assert!(protocol::WORK_ENVELOPE_SCHEMA.contains("work-envelope.v1"));
    assert!(protocol::parse_runtime_descriptor_file(&fixture("valid/wasi.json")).is_ok());
    assert!(protocol::parse_runtime_descriptor_file(&fixture("valid/oci.json")).is_ok());
    assert!(protocol::parse_runtime_descriptor_file(&fixture("invalid/oci-tag.json")).is_err());
}

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn token_hash(token: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(token.as_bytes()))
}

fn envelope(token: &str) -> Value {
    json!({
        "envelopeVersion": 1,
        "executionId": "10000000-0000-4000-8000-000000000001",
        "accountId": "10000000-0000-4000-8000-000000000002",
        "projectId": "10000000-0000-4000-8000-000000000003",
        "installationId": "10000000-0000-4000-8000-000000000004",
        "idempotencyKey": "module-execution-op-1",
        "installRevision": 3,
        "releaseId": "10000000-0000-4000-8000-000000000007",
        "releaseDigest": digest('1'),
        "consentRevisionId": "10000000-0000-4000-8000-000000000008",
        "permissionDigest": digest('4'),
        "runtimeDescriptorId": "10000000-0000-4000-8000-000000000009",
        "runtimeDescriptorDigest": "sha256:34e670fbb2510c18e701afc47c2ecefe4ced432b0db6d66739e3dd0bba7aa04b",
        "inputDigest": "sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
        "runtimeArtifactDigest": digest('6'),
        "runtimeArtifactBytes": 4096,
        "runtimeKind": "wasi-component",
        "runtimeProfile": "openopc-wasi-v1",
        "policyDigest": digest('3'),
        "killSwitchGeneration": 7,
        "executionDeadline": "2026-07-30T10:30:00.000Z",
        "bindingDigest": "sha256:8a6738ae79db9db09921ea35975c384123332aa95b4a543acf4877f94a9eba26",
        "resourceCeilings": {
            "cpuMillis": 60000,
            "memoryMiB": 512,
            "wallTimeMs": 120000,
            "costMicro": 50000
        },
        "lease": {
            "id": "10000000-0000-4000-8000-000000000005",
            "generation": 1,
            "deadline": "2026-07-30T10:00:00.000Z"
        },
        "grants": [{
            "id": "10000000-0000-4000-8000-000000000006",
            "audience": "openopc:capability/egress",
            "tokenHash": token_hash(token)
        }]
    })
}

fn signed_claim(
    envelope: &Value,
    token: &str,
    key: &SigningKey,
) -> protocol::RunnerClaimResponseV1 {
    let protected = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "alg": "EdDSA",
            "typ": "openopc-work-envelope+jwt",
            "kid": "staging-execution-v1",
            "traceparent": "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
        }))
        .unwrap(),
    );
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(envelope).unwrap());
    let signing_input = format!("{protected}.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(key.sign(signing_input.as_bytes()).to_bytes());
    protocol::RunnerClaimResponseV1 {
        signed_envelope: format!("{signing_input}.{signature}"),
        capability_tokens: vec![protocol::RunnerCapabilityTokenV1 {
            grant_id: "10000000-0000-4000-8000-000000000006".into(),
            audience: protocol::CapabilityAudience::Egress,
            token: token.into(),
        }],
    }
}

#[test]
fn reproduces_the_typescript_binding_digest_vector() {
    let parsed = protocol::parse_work_envelope_value(envelope("capability-token")).unwrap();
    assert_eq!(
        protocol::compute_binding_digest(&parsed).unwrap(),
        "sha256:8a6738ae79db9db09921ea35975c384123332aa95b4a543acf4877f94a9eba26"
    );
}

fn claim_bundle() -> Value {
    let runtime_descriptor: Value =
        serde_json::from_slice(&fs::read(fixture("valid/wasi.json")).unwrap()).unwrap();
    json!({
        "signedEnvelope": "e30.e30.e30",
        "capabilityTokens": [{
            "grantId": "10000000-0000-4000-8000-000000000006",
            "audience": "egress",
            "token": "bounded-capability-token"
        }],
        "runtimeDescriptor": runtime_descriptor,
        "inputBase64": "eyJhIjoxfQ",
        "runtimeArtifact": {
            "fetchPath": "module-runtime/artifacts/fetch",
            "digest": digest('6'),
            "bytes": 4096
        }
    })
}

#[test]
fn parses_only_the_strict_bounded_claim_bundle_shape() {
    let parsed = protocol::parse_runner_claim_bundle_value(claim_bundle()).unwrap();
    assert_eq!(parsed.input_base64, "eyJhIjoxfQ");
    assert_eq!(parsed.runtime_artifact.bytes, 4096);

    let mut unknown = claim_bundle();
    unknown["unexpected"] = json!(true);
    assert!(protocol::parse_runner_claim_bundle_value(unknown).is_err());

    let mut padded = claim_bundle();
    padded["inputBase64"] = json!("eyJhIjoxfQ=");
    assert!(protocol::parse_runner_claim_bundle_value(padded).is_err());

    let mut wrong_path = claim_bundle();
    wrong_path["runtimeArtifact"]["fetchPath"] = json!("alternate/path");
    assert!(protocol::parse_runner_claim_bundle_value(wrong_path).is_err());

    let mut oversized_artifact = claim_bundle();
    oversized_artifact["runtimeArtifact"]["bytes"] = json!(33_554_433);
    assert!(protocol::parse_runner_claim_bundle_value(oversized_artifact).is_err());

    let mut duplicate_grants = claim_bundle();
    let duplicated = duplicate_grants["capabilityTokens"][0].clone();
    duplicate_grants["capabilityTokens"] = json!([duplicated.clone(), duplicated]);
    assert!(protocol::parse_runner_claim_bundle_value(duplicate_grants).is_err());
}

#[test]
fn verifies_the_signed_envelope_and_capability_hashes() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let claim = signed_claim(&envelope("capability-token"), "capability-token", &key);
    let now = Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, 0).unwrap();

    let verified =
        protocol::verify_claim_response(claim, &key.verifying_key(), "staging-execution-v1", now)
            .unwrap();

    assert_eq!(verified.envelope.lease.generation, 1);
    assert_eq!(verified.capability_tokens.len(), 1);
}

#[test]
fn rejects_a_claim_when_a_token_hash_or_lease_fence_is_invalid() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let now = Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, 0).unwrap();
    let wrong_token = signed_claim(&envelope("expected-token"), "substituted-token", &key);
    assert!(
        protocol::verify_claim_response(
            wrong_token,
            &key.verifying_key(),
            "staging-execution-v1",
            now,
        )
        .is_err()
    );

    let mut invalid_generation = envelope("capability-token");
    invalid_generation["lease"]["generation"] = json!(0);
    let invalid_generation = signed_claim(&invalid_generation, "capability-token", &key);
    assert!(
        protocol::verify_claim_response(
            invalid_generation,
            &key.verifying_key(),
            "staging-execution-v1",
            now,
        )
        .is_err()
    );

    let expired = signed_claim(&envelope("capability-token"), "capability-token", &key);
    let after_deadline = Utc.with_ymd_and_hms(2026, 7, 30, 10, 0, 1).unwrap();
    assert!(
        protocol::verify_claim_response(
            expired,
            &key.verifying_key(),
            "staging-execution-v1",
            after_deadline,
        )
        .is_err()
    );
}

fn config_values(directory: &TempDir) -> HashMap<String, String> {
    let public_key = directory.path().join("execution-signing-public.pem");
    let certificate = directory.path().join("runner-cert.pem");
    let private_key = directory.path().join("runner-key.pem");
    fs::write(&public_key, "public-key-fixture").unwrap();
    fs::write(&certificate, "certificate-fixture").unwrap();
    fs::write(&private_key, "private-key-fixture").unwrap();
    HashMap::from([
        ("OPENOPC_MODULE_RUNNER_ENABLED".into(), "true".into()),
        (
            "OPENOPC_RUNNER_CONTROL_PLANE_URL".into(),
            "https://control.openopc.example".into(),
        ),
        (
            "OPENOPC_RUNNER_CONTROL_PLANE_PUBLIC_KEY_FILE".into(),
            public_key.display().to_string(),
        ),
        (
            "OPENOPC_RUNNER_CONTROL_PLANE_KEY_ID".into(),
            "staging-execution-v1".into(),
        ),
        (
            "OPENOPC_RUNNER_NODE_IDENTITY".into(),
            "runner-node-01".into(),
        ),
        (
            "OPENOPC_RUNNER_ID".into(),
            "10000000-0000-4000-8000-000000000010".into(),
        ),
        (
            "OPENOPC_RUNNER_ACCOUNT_ID".into(),
            "10000000-0000-4000-8000-000000000002".into(),
        ),
        (
            "OPENOPC_RUNNER_MTLS_CERT_FILE".into(),
            certificate.display().to_string(),
        ),
        (
            "OPENOPC_RUNNER_MTLS_KEY_FILE".into(),
            private_key.display().to_string(),
        ),
        (
            "OPENOPC_RUNNER_SUPPORTED_PROFILES".into(),
            "wasi-component:wasmtime-component-v1,oci-image:gvisor-standard".into(),
        ),
        ("OPENOPC_RUNNER_CONTRACT_VERSION".into(), "1".into()),
        ("OPENOPC_RUNNER_SOFTWARE_VERSION".into(), "0.1.0".into()),
        ("OPENOPC_RUNNER_ATTESTATION_DIGEST".into(), digest('a')),
        ("OPENOPC_RUNNER_CAPACITY".into(), "4".into()),
        ("OPENOPC_RUNNER_DRAIN".into(), "false".into()),
        ("OPENOPC_RUNNER_LISTEN_ADDR".into(), "127.0.0.1:8080".into()),
    ])
}

#[test]
fn refuses_to_start_when_any_security_critical_runner_setting_is_missing() {
    let directory = TempDir::new().unwrap();
    let values = config_values(&directory);
    let required = [
        "OPENOPC_MODULE_RUNNER_ENABLED",
        "OPENOPC_RUNNER_CONTROL_PLANE_URL",
        "OPENOPC_RUNNER_CONTROL_PLANE_PUBLIC_KEY_FILE",
        "OPENOPC_RUNNER_CONTROL_PLANE_KEY_ID",
        "OPENOPC_RUNNER_NODE_IDENTITY",
        "OPENOPC_RUNNER_ID",
        "OPENOPC_RUNNER_ACCOUNT_ID",
        "OPENOPC_RUNNER_MTLS_CERT_FILE",
        "OPENOPC_RUNNER_MTLS_KEY_FILE",
        "OPENOPC_RUNNER_SUPPORTED_PROFILES",
        "OPENOPC_RUNNER_CONTRACT_VERSION",
        "OPENOPC_RUNNER_SOFTWARE_VERSION",
        "OPENOPC_RUNNER_ATTESTATION_DIGEST",
        "OPENOPC_RUNNER_CAPACITY",
    ];
    for name in required {
        let mut missing = values.clone();
        missing.remove(name);
        assert!(
            config::RunnerConfig::from_map(&missing).is_err(),
            "accepted missing {name}"
        );
    }

    let parsed = config::RunnerConfig::from_map(&values).unwrap();
    assert_eq!(parsed.contract_version, 1);
    assert_eq!(parsed.profiles.len(), 2);
    assert_eq!(parsed.capacity, 4);
    assert_eq!(parsed.shutdown_timeout, std::time::Duration::from_secs(30));
}

#[test]
fn refuses_plain_http_or_an_unsupported_contract_version() {
    let directory = TempDir::new().unwrap();
    let mut values = config_values(&directory);
    values.insert(
        "OPENOPC_RUNNER_CONTROL_PLANE_URL".into(),
        "http://control.openopc.example".into(),
    );
    assert!(config::RunnerConfig::from_map(&values).is_err());

    values.insert(
        "OPENOPC_RUNNER_CONTROL_PLANE_URL".into(),
        "https://control.openopc.example".into(),
    );
    values.insert("OPENOPC_RUNNER_CONTRACT_VERSION".into(), "2".into());
    assert!(config::RunnerConfig::from_map(&values).is_err());
}

fn verified_claim(key: &SigningKey) -> protocol::VerifiedClaim {
    protocol::verify_claim_response(
        signed_claim(&envelope("capability-token"), "capability-token", key),
        &key.verifying_key(),
        "staging-execution-v1",
        Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, 0).unwrap(),
    )
    .unwrap()
}

struct FakeTransport {
    responses: Mutex<VecDeque<Result<client::ControlPlaneResponse, client::RunnerClientError>>>,
    requests: Mutex<Vec<client::ControlPlaneRequest>>,
}

impl FakeTransport {
    fn new(responses: impl IntoIterator<Item = client::ControlPlaneResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().map(Ok).collect()),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn with_outcomes(
        responses: impl IntoIterator<
            Item = Result<client::ControlPlaneResponse, client::RunnerClientError>,
        >,
    ) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> Vec<client::ControlPlaneRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl client::ControlPlaneTransport for FakeTransport {
    fn post<'a>(&'a self, request: client::ControlPlaneRequest) -> client::TransportFuture<'a> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Err(client::RunnerClientError::Transport))
        })
    }
}

fn response(status: u16, body: Value) -> client::ControlPlaneResponse {
    client::ControlPlaneResponse {
        status,
        body: serde_json::to_vec(&body).unwrap(),
    }
}

fn test_client(
    key: &SigningKey,
    responses: impl IntoIterator<Item = client::ControlPlaneResponse>,
) -> (client::RunnerClient, Arc<FakeTransport>) {
    let transport = Arc::new(FakeTransport::new(responses));
    let client = client::RunnerClient::with_transport(
        Uuid::parse_str("10000000-0000-4000-8000-000000000010").unwrap(),
        Uuid::parse_str("10000000-0000-4000-8000-000000000002").unwrap(),
        key.verifying_key(),
        "staging-execution-v1".into(),
        transport.clone(),
    );
    (client, transport)
}

#[tokio::test]
async fn claim_next_returns_none_for_an_unavailable_execution_and_verifies_a_delivered_bundle() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let (missing_client, missing_transport) = test_client(&key, [response(204, json!({}))]);
    assert!(
        missing_client
            .claim_next_at(Utc::now())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        missing_transport.requests(),
        [client::ControlPlaneRequest {
            path: "module-runtime/claims/next".into(),
            runner_id: "10000000-0000-4000-8000-000000000010".into(),
            account_id: "10000000-0000-4000-8000-000000000002".into(),
            body: json!({}),
        }]
    );

    let signed = signed_claim(&envelope("capability-token"), "capability-token", &key);
    let mut delivered = claim_bundle();
    delivered["signedEnvelope"] = json!(signed.signed_envelope);
    delivered["capabilityTokens"] = serde_json::to_value(signed.capability_tokens).unwrap();
    let (client, _) = test_client(&key, [response(200, delivered)]);
    let bundle = client
        .claim_next_at(Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, 0).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        bundle.claim.envelope.execution_id,
        "10000000-0000-4000-8000-000000000001"
    );
    assert_eq!(bundle.input, br#"{"a":1}"#);
}

#[tokio::test]
async fn preserves_a_trusted_claim_when_bound_bundle_metadata_is_invalid() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let signed = signed_claim(&envelope("capability-token"), "capability-token", &key);
    let mut delivered = claim_bundle();
    delivered["signedEnvelope"] = json!(signed.signed_envelope);
    delivered["capabilityTokens"] = serde_json::to_value(signed.capability_tokens).unwrap();
    delivered["runtimeDescriptor"]["runtime"]["operation"] = json!("substituted");
    let (client, _) = test_client(&key, [response(200, delivered)]);

    let error = client
        .claim_next_at(Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, 0).unwrap())
        .await
        .unwrap_err();

    let client::RunnerClientError::TrustedClaimBundle { claim, code } = error else {
        panic!("expected a trusted bundle failure");
    };
    assert_eq!(
        claim.envelope.execution_id,
        "10000000-0000-4000-8000-000000000001"
    );
    assert_eq!(
        code,
        client::TrustedClaimFailureCode::DescriptorDigestMismatch
    );
}

#[tokio::test]
async fn derives_lease_coordinates_and_sends_finalize_only_once() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let claim = verified_claim(&key);
    let (client, transport) = test_client(
        &key,
        [
            response(
                200,
                json!({
                    "execution": {
                        "executionId": "10000000-0000-4000-8000-000000000001",
                        "state": "running"
                    },
                    "lease": {
                        "leaseId": "10000000-0000-4000-8000-000000000005",
                        "executionId": "10000000-0000-4000-8000-000000000001",
                        "generation": 1,
                        "deadlineAt": "2026-07-30T10:00:00.000Z",
                        "releasedAt": null
                    }
                }),
            ),
            response(200, json!({ "sequence": 2 })),
            response(200, json!({ "state": "succeeded" })),
        ],
    );
    let lease_body = json!({
        "projectId": "10000000-0000-4000-8000-000000000003",
        "executionId": "10000000-0000-4000-8000-000000000001",
        "leaseId": "10000000-0000-4000-8000-000000000005",
        "generation": 1
    });
    let heartbeat = client.heartbeat(&claim).await.unwrap();
    assert_eq!(
        heartbeat.execution.state,
        client::HeartbeatExecutionState::Running
    );
    assert_eq!(heartbeat.lease.generation, 1);

    client
        .append_evidence(&claim, "runtime_started", json!({ "runtime": "oci-image" }))
        .await
        .unwrap();

    let finalize = client::FinalizeInput {
        outcome: client::TerminalOutcome::Succeeded,
        evidence_digest: "sha256:bc1cc9f74fae9166b2b01c9c94f1ff5a10a3fda7e94ac4879359ce65aaf72f76"
            .into(),
        evidence: json!({ "result": "bounded" }),
        usage: json!({ "cpuMillis": 12 }),
    };
    client.finalize(&claim, finalize.clone()).await.unwrap();
    assert!(client.finalize(&claim, finalize).await.is_err());

    let requests = transport.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].path, "module-runtime/leases/heartbeat");
    assert_eq!(requests[0].body, lease_body);
    assert_eq!(requests[1].path, "module-runtime/evidence");
    assert_eq!(requests[1].body["eventType"], "runtime_started");
    assert_eq!(requests[2].path, "module-runtime/finalize");
    assert_eq!(requests[2].body["outcome"], "succeeded");
}

#[tokio::test]
async fn rejects_sensitive_evidence_before_it_reaches_the_transport() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let claim = verified_claim(&key);
    let (client, transport) = test_client(&key, []);

    let error = client
        .append_evidence(
            &claim,
            "runtime_started",
            json!({ "authorization": "must-not-leak" }),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, client::RunnerClientError::InvalidEvidence));
    assert!(transport.requests().is_empty());
}

#[tokio::test]
async fn invalid_finalize_input_does_not_consume_the_finalize_fence() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let claim = verified_claim(&key);
    let (client, transport) = test_client(&key, [response(200, json!({ "state": "succeeded" }))]);
    let evidence = json!({ "result": "bounded" });

    let invalid = client::FinalizeInput {
        outcome: client::TerminalOutcome::Succeeded,
        evidence_digest: digest('e'),
        evidence: evidence.clone(),
        usage: json!({ "cpuMillis": 12 }),
    };
    assert!(matches!(
        client.finalize(&claim, invalid).await,
        Err(client::RunnerClientError::InvalidEvidence)
    ));

    let valid = client::FinalizeInput {
        outcome: client::TerminalOutcome::Succeeded,
        evidence_digest: "sha256:bc1cc9f74fae9166b2b01c9c94f1ff5a10a3fda7e94ac4879359ce65aaf72f76"
            .into(),
        evidence,
        usage: json!({ "cpuMillis": 12 }),
    };
    client.finalize(&claim, valid.clone()).await.unwrap();
    assert!(matches!(
        client.finalize(&claim, valid).await,
        Err(client::RunnerClientError::AlreadyFinalized)
    ));
    assert_eq!(transport.requests().len(), 1);
}

#[tokio::test]
async fn finalize_restores_retryable_fences_and_closes_acknowledged_or_permanent_results() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let claim = verified_claim(&key);
    let retry_transport = Arc::new(FakeTransport::with_outcomes([
        Ok(response(503, json!({ "error": "unavailable" }))),
        Err(client::RunnerClientError::Transport),
        Ok(response(200, json!({ "state": "succeeded" }))),
    ]));
    let retry_client = client::RunnerClient::with_transport(
        Uuid::parse_str("10000000-0000-4000-8000-000000000010").unwrap(),
        Uuid::parse_str("10000000-0000-4000-8000-000000000002").unwrap(),
        key.verifying_key(),
        "staging-execution-v1".into(),
        retry_transport.clone(),
    );
    let input = client::FinalizeInput {
        outcome: client::TerminalOutcome::Succeeded,
        evidence_digest: "sha256:bc1cc9f74fae9166b2b01c9c94f1ff5a10a3fda7e94ac4879359ce65aaf72f76"
            .into(),
        evidence: json!({ "result": "bounded" }),
        usage: json!({ "cpuMillis": 12 }),
    };

    assert!(matches!(
        retry_client.finalize(&claim, input.clone()).await,
        Err(client::RunnerClientError::Status(503))
    ));
    assert_eq!(
        retry_client.finalize_fence_state(&claim),
        client::FinalizeFenceState::Available
    );
    assert!(matches!(
        retry_client.finalize(&claim, input.clone()).await,
        Err(client::RunnerClientError::Transport)
    ));
    assert_eq!(
        retry_client.finalize_fence_state(&claim),
        client::FinalizeFenceState::Available
    );
    retry_client.finalize(&claim, input.clone()).await.unwrap();
    assert_eq!(
        retry_client.finalize_fence_state(&claim),
        client::FinalizeFenceState::Acknowledged
    );
    assert!(matches!(
        retry_client.finalize(&claim, input.clone()).await,
        Err(client::RunnerClientError::AlreadyFinalized)
    ));
    assert_eq!(retry_transport.requests().len(), 3);

    let permanent_transport = Arc::new(FakeTransport::new([
        response(409, json!({ "error": "stale" })),
        response(200, json!({ "state": "succeeded" })),
    ]));
    let permanent_client = client::RunnerClient::with_transport(
        Uuid::parse_str("10000000-0000-4000-8000-000000000010").unwrap(),
        Uuid::parse_str("10000000-0000-4000-8000-000000000002").unwrap(),
        key.verifying_key(),
        "staging-execution-v1".into(),
        permanent_transport.clone(),
    );
    assert!(matches!(
        permanent_client.finalize(&claim, input.clone()).await,
        Err(client::RunnerClientError::Status(409))
    ));
    assert_eq!(
        permanent_client.finalize_fence_state(&claim),
        client::FinalizeFenceState::Acknowledged
    );
    assert!(matches!(
        permanent_client.finalize(&claim, input).await,
        Err(client::RunnerClientError::AlreadyFinalized)
    ));
    assert_eq!(permanent_transport.requests().len(), 1);
}

struct BlockingTransport {
    requests: Mutex<Vec<client::ControlPlaneRequest>>,
    started: Notify,
    release: Notify,
}

impl client::ControlPlaneTransport for BlockingTransport {
    fn post<'a>(&'a self, request: client::ControlPlaneRequest) -> client::TransportFuture<'a> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request);
            self.started.notify_one();
            self.release.notified().await;
            Ok(response(200, json!({ "state": "succeeded" })))
        })
    }
}

#[tokio::test]
async fn concurrent_finalize_calls_observe_the_in_flight_fence() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let claim = verified_claim(&key);
    let transport = Arc::new(BlockingTransport {
        requests: Mutex::new(Vec::new()),
        started: Notify::new(),
        release: Notify::new(),
    });
    let client = client::RunnerClient::with_transport(
        Uuid::parse_str("10000000-0000-4000-8000-000000000010").unwrap(),
        Uuid::parse_str("10000000-0000-4000-8000-000000000002").unwrap(),
        key.verifying_key(),
        "staging-execution-v1".into(),
        transport.clone(),
    );
    let input = client::FinalizeInput {
        outcome: client::TerminalOutcome::Succeeded,
        evidence_digest: "sha256:bc1cc9f74fae9166b2b01c9c94f1ff5a10a3fda7e94ac4879359ce65aaf72f76"
            .into(),
        evidence: json!({ "result": "bounded" }),
        usage: json!({ "cpuMillis": 12 }),
    };
    let first_client = client.clone();
    let first_claim = claim.clone();
    let first_input = input.clone();
    let first = tokio::spawn(async move { first_client.finalize(&first_claim, first_input).await });
    transport.started.notified().await;

    assert!(matches!(
        client.finalize(&claim, input).await,
        Err(client::RunnerClientError::FinalizeInFlight)
    ));
    assert_eq!(
        client.finalize_fence_state(&claim),
        client::FinalizeFenceState::InFlight
    );
    transport.release.notify_one();
    first.await.unwrap().unwrap();
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn node_heartbeat_uses_only_bounded_config_owned_identity() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let (client, transport) = test_client(&key, [response(200, json!({ "status": "active" }))]);
    client.heartbeat_node("0.1.0", &digest('a')).await.unwrap();
    let requests = transport.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "module-runtime/runners/heartbeat");
    assert_eq!(
        requests[0].body,
        json!({ "softwareVersion": "0.1.0", "attestationDigest": digest('a') })
    );
}

#[test]
fn evidence_is_bounded_redaction_safe_and_canonically_digested() {
    let first = json!({
        "runtime": "wasi-component",
        "usage": { "cpuMillis": 12, "outputBytes": 24 },
        "result": ["asset-1", "asset-2"]
    });
    let reordered = json!({
        "result": ["asset-1", "asset-2"],
        "usage": { "outputBytes": 24, "cpuMillis": 12 },
        "runtime": "wasi-component"
    });
    let sanitized = evidence::sanitize_evidence(first).unwrap();
    assert_eq!(
        evidence::evidence_digest(&sanitized).unwrap(),
        evidence::evidence_digest(&reordered).unwrap()
    );

    for forbidden in [
        "authorization",
        "capabilityToken",
        "password",
        "prompt",
        "providerBody",
        "rawSource",
        "secret",
        "signedUrl",
    ] {
        let value = Value::Object(serde_json::Map::from_iter([(
            forbidden.to_owned(),
            Value::String("must-not-leak".into()),
        )]));
        assert!(
            evidence::sanitize_evidence(value).is_err(),
            "accepted forbidden evidence field {forbidden}"
        );
    }
    assert!(evidence::sanitize_evidence(json!({ "value": "x".repeat(300_000) })).is_err());
}

#[tokio::test]
async fn health_is_live_while_readiness_reports_every_runner_dependency() {
    let directory = TempDir::new().unwrap();
    let mut values = config_values(&directory);
    let unavailable_config = config::RunnerConfig::from_map(&values).unwrap();
    let unavailable =
        service::runner_router(Arc::new(service::RunnerState::new(&unavailable_config)));
    let health = unavailable
        .clone()
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    let readiness = unavailable
        .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(readiness.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: Value =
        serde_json::from_slice(&to_bytes(readiness.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(body["protocolVersion"], 1);
    assert_eq!(body["nodeRegistration"], "unavailable");
    assert_eq!(body["wasmtimeIdentity"], Value::Null);
    assert_eq!(body["ociProfileStatus"], "disabled");
    assert_eq!(body["drain"], false);
    assert_eq!(body["capacity"], json!({ "total": 4, "available": 4 }));

    values.insert(
        "OPENOPC_RUNNER_SUPPORTED_PROFILES".into(),
        "wasi-component:wasmtime-component-v1".into(),
    );
    values.insert(
        "OPENOPC_RUNNER_WASMTIME_IDENTITY".into(),
        "wasmtime:47.0.2".into(),
    );
    let ready_config = config::RunnerConfig::from_map(&values).unwrap();
    let ready_state = Arc::new(service::RunnerState::new(&ready_config));
    ready_state.set_node_registered(true);
    let ready = service::runner_router(ready_state);
    let response = ready
        .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
