use std::future::pending;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use openopc_module_runner::client::{
    self, ArtifactFetchResponse, RunnerClientError, RuntimeArtifactClient,
    RuntimeArtifactFetchRequest,
};
use openopc_module_runner::protocol::{
    RuntimeArtifactReference, VerifiedClaim, VerifiedExecutionBundle,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const MAX_ARTIFACT_BYTES: u64 = 33_554_432;

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn bundle(digest: String, bytes: u64) -> VerifiedExecutionBundle {
    let envelope = serde_json::from_value(json!({
        "envelopeVersion": 1,
        "executionId": "10000000-0000-4000-8000-000000000001",
        "accountId": "20000000-0000-4000-8000-000000000001",
        "projectId": "30000000-0000-4000-8000-000000000001",
        "installationId": "40000000-0000-4000-8000-000000000001",
        "idempotencyKey": "execution-op-1",
        "installRevision": 1,
        "releaseId": "50000000-0000-4000-8000-000000000001",
        "releaseDigest": format!("sha256:{}", "2".repeat(64)),
        "consentRevisionId": "60000000-0000-4000-8000-000000000001",
        "permissionDigest": format!("sha256:{}", "3".repeat(64)),
        "runtimeDescriptorId": "70000000-0000-4000-8000-000000000001",
        "runtimeDescriptorDigest": format!("sha256:{}", "4".repeat(64)),
        "inputDigest": sha256(br#"{}"#),
        "runtimeArtifactDigest": digest,
        "runtimeArtifactBytes": bytes,
        "runtimeKind": "wasi-component",
        "runtimeProfile": "openopc-wasi-v1",
        "policyDigest": format!("sha256:{}", "5".repeat(64)),
        "killSwitchGeneration": 0,
        "executionDeadline": "2026-07-27T09:00:00.000Z",
        "bindingDigest": format!("sha256:{}", "6".repeat(64)),
        "resourceCeilings": {
            "cpuMillis": 10_000,
            "memoryMiB": 512,
            "wallTimeMs": 120_000,
            "costMicro": 0
        },
        "lease": {
            "id": "80000000-0000-4000-8000-000000000001",
            "generation": 1,
            "deadline": "2026-07-27T08:00:30.000Z"
        },
        "grants": []
    }))
    .unwrap();
    let descriptor = serde_json::from_value(json!({
        "descriptorVersion": 1,
        "runtime": {
            "kind": "wasi-component",
            "component": "runtime/main.wasm",
            "world": "openopc:module/runtime",
            "operation": "run",
            "imports": [],
            "limits": {
                "cpuMillis": 10_000,
                "fuel": 10_000_000,
                "memoryMiB": 512,
                "outputBytes": 1_048_576,
                "pids": 16,
                "wallTimeMs": 120_000
            }
        }
    }))
    .unwrap();
    VerifiedExecutionBundle {
        claim: VerifiedClaim {
            envelope,
            capability_tokens: vec![],
        },
        runtime_descriptor: descriptor,
        input: br#"{}"#.to_vec(),
        runtime_artifact: RuntimeArtifactReference {
            fetch_path: "module-runtime/artifacts/fetch".into(),
            digest,
            bytes,
        },
    }
}

enum FetchMode {
    Complete {
        status: u16,
        content_type: Option<String>,
        content_length: Option<u64>,
        digest: Option<String>,
        chunks: Vec<Vec<u8>>,
    },
    Error,
    Pending,
    Panic,
}

struct RecordingTransport {
    mode: FetchMode,
    requests: Mutex<Vec<RuntimeArtifactFetchRequest>>,
}

impl RecordingTransport {
    fn complete(
        chunks: Vec<Vec<u8>>,
        content_type: Option<&str>,
        content_length: Option<u64>,
        digest: Option<String>,
    ) -> Self {
        Self {
            mode: FetchMode::Complete {
                status: 200,
                content_type: content_type.map(str::to_owned),
                content_length,
                digest,
                chunks,
            },
            requests: Mutex::new(Vec::new()),
        }
    }

    fn status(status: u16) -> Self {
        Self {
            mode: FetchMode::Complete {
                status,
                content_type: None,
                content_length: None,
                digest: None,
                chunks: vec![],
            },
            requests: Mutex::new(Vec::new()),
        }
    }

    fn mode(mode: FetchMode) -> Self {
        Self {
            mode,
            requests: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> Vec<RuntimeArtifactFetchRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl client::ControlPlaneTransport for RecordingTransport {
    fn post<'a>(&'a self, _request: client::ControlPlaneRequest) -> client::TransportFuture<'a> {
        Box::pin(async { Err(RunnerClientError::Transport) })
    }

    fn fetch_to<'a>(
        &'a self,
        request: RuntimeArtifactFetchRequest,
    ) -> client::ArtifactTransportFuture<'a> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request.clone());
            match &self.mode {
                FetchMode::Error => Err(RunnerClientError::Transport),
                FetchMode::Pending => {
                    pending::<Result<ArtifactFetchResponse, RunnerClientError>>().await
                }
                FetchMode::Panic => panic!("injected artifact transport panic"),
                FetchMode::Complete {
                    status,
                    content_type,
                    content_length,
                    digest,
                    chunks,
                } => {
                    if !(200..300).contains(status) {
                        return Ok(ArtifactFetchResponse {
                            status: *status,
                            content_type: content_type.clone(),
                            content_length: *content_length,
                            digest: digest.clone(),
                            body_digest: None,
                            bytes_written: 0,
                        });
                    }
                    let mut file = tokio::fs::File::create(&request.destination)
                        .await
                        .map_err(|_| RunnerClientError::ArtifactIo)?;
                    let mut hasher = Sha256::new();
                    let mut total = 0_u64;
                    for chunk in chunks {
                        total = total
                            .checked_add(chunk.len() as u64)
                            .ok_or(RunnerClientError::ArtifactLimit)?;
                        if total > request.max_bytes {
                            return Err(RunnerClientError::ArtifactLimit);
                        }
                        file.write_all(chunk)
                            .await
                            .map_err(|_| RunnerClientError::ArtifactIo)?;
                        hasher.update(chunk);
                    }
                    file.flush()
                        .await
                        .map_err(|_| RunnerClientError::ArtifactIo)?;
                    Ok(ArtifactFetchResponse {
                        status: *status,
                        content_type: content_type.clone(),
                        content_length: *content_length,
                        digest: digest.clone(),
                        body_digest: Some(format!("sha256:{:x}", hasher.finalize())),
                        bytes_written: total,
                    })
                }
            }
        })
    }
}

fn client(transport: Arc<RecordingTransport>) -> RuntimeArtifactClient {
    RuntimeArtifactClient::with_transport(
        Uuid::parse_str("90000000-0000-4000-8000-000000000001").unwrap(),
        Uuid::parse_str("20000000-0000-4000-8000-000000000001").unwrap(),
        transport,
    )
}

#[tokio::test]
async fn streams_a_full_32_mib_artifact_without_the_control_plane_body_limit() {
    let bytes = vec![0x5a; MAX_ARTIFACT_BYTES as usize];
    let digest = sha256(&bytes);
    let transport = Arc::new(RecordingTransport::complete(
        vec![bytes],
        Some("application/wasm"),
        Some(MAX_ARTIFACT_BYTES),
        Some(digest.clone()),
    ));
    let artifact = client(transport.clone())
        .fetch(&bundle(digest, MAX_ARTIFACT_BYTES))
        .await
        .unwrap();
    let path = artifact.path().to_owned();

    assert_eq!(std::fs::metadata(&path).unwrap().len(), MAX_ARTIFACT_BYTES);
    assert_eq!(transport.requests()[0].max_bytes, MAX_ARTIFACT_BYTES);
    drop(artifact);
    assert!(!path.exists());
}

#[tokio::test]
async fn accepts_a_streamed_artifact_without_content_length_when_body_and_digest_match() {
    let bytes = vec![0, 97, 115, 109];
    let digest = sha256(&bytes);
    let transport = Arc::new(RecordingTransport::complete(
        vec![bytes],
        Some("application/wasm"),
        None,
        Some(digest.clone()),
    ));

    let artifact = client(transport)
        .fetch(&bundle(digest, 4))
        .await
        .expect("streaming responses may omit Content-Length");
    let path = artifact.path().to_owned();
    assert_eq!(std::fs::metadata(&path).unwrap().len(), 4);
    drop(artifact);
    assert!(!path.exists());
}

#[tokio::test]
async fn rejects_artifact_limits_metadata_lengths_statuses_and_transport_failures() {
    let exact = vec![0, 97, 115, 109];
    let digest = sha256(&exact);

    let oversized_transport = Arc::new(RecordingTransport::status(200));
    let error = client(oversized_transport.clone())
        .fetch(&bundle(digest.clone(), MAX_ARTIFACT_BYTES + 1))
        .await
        .unwrap_err();
    assert!(matches!(error, RunnerClientError::ArtifactLimit));
    assert!(oversized_transport.requests().is_empty());

    let cases = [
        (
            Arc::new(RecordingTransport::complete(
                vec![exact.clone()],
                None,
                Some(4),
                Some(digest.clone()),
            )),
            "metadata",
        ),
        (
            Arc::new(RecordingTransport::complete(
                vec![exact.clone()],
                Some("application/octet-stream"),
                Some(4),
                Some(digest.clone()),
            )),
            "content-type",
        ),
        (
            Arc::new(RecordingTransport::complete(
                vec![exact.clone()],
                Some("application/wasm"),
                Some(5),
                Some(digest.clone()),
            )),
            "content-length",
        ),
        (
            Arc::new(RecordingTransport::complete(
                vec![exact.clone()],
                Some("application/wasm"),
                Some(4),
                Some(format!("sha256:{}", "0".repeat(64))),
            )),
            "digest-header",
        ),
        (Arc::new(RecordingTransport::status(302)), "redirect"),
        (Arc::new(RecordingTransport::status(404)), "not-found"),
        (
            Arc::new(RecordingTransport::complete(
                vec![exact[..3].to_vec()],
                Some("application/wasm"),
                Some(4),
                Some(digest.clone()),
            )),
            "short-body",
        ),
        (
            Arc::new(RecordingTransport::complete(
                vec![vec![0, 97, 115, 109, 0]],
                Some("application/wasm"),
                Some(4),
                Some(digest.clone()),
            )),
            "long-body",
        ),
        (
            Arc::new(RecordingTransport::complete(
                vec![vec![0, 97, 115, 108]],
                Some("application/wasm"),
                Some(4),
                Some(digest.clone()),
            )),
            "body-digest",
        ),
        (
            Arc::new(RecordingTransport::mode(FetchMode::Error)),
            "transport",
        ),
    ];

    for (transport, name) in cases {
        let error = client(transport.clone())
            .fetch(&bundle(digest.clone(), 4))
            .await
            .expect_err(name);
        assert!(
            matches!(
                error,
                RunnerClientError::ArtifactMetadata
                    | RunnerClientError::ArtifactLength
                    | RunnerClientError::ArtifactDigest
                    | RunnerClientError::ArtifactLimit
                    | RunnerClientError::Status(_)
                    | RunnerClientError::Transport
            ),
            "unexpected {name} error: {error}"
        );
        let path = transport.requests()[0].destination.clone();
        assert!(!path.exists(), "temporary file survived {name}");
    }
}

async fn wait_for_destination(transport: &RecordingTransport) -> PathBuf {
    loop {
        if let Some(request) = transport.requests().first() {
            return request.destination.clone();
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn removes_the_private_temporary_file_on_cancellation_and_panic() {
    let digest = sha256(&[0, 97, 115, 109]);

    let pending_transport = Arc::new(RecordingTransport::mode(FetchMode::Pending));
    let pending_client = client(pending_transport.clone());
    let pending_bundle = bundle(digest.clone(), 4);
    let task = tokio::spawn(async move { pending_client.fetch(&pending_bundle).await });
    let pending_path = wait_for_destination(&pending_transport).await;
    assert!(pending_path.exists());
    task.abort();
    let _ = task.await;
    assert!(!pending_path.exists());

    let panic_transport = Arc::new(RecordingTransport::mode(FetchMode::Panic));
    let panic_client = client(panic_transport.clone());
    let panic_bundle = bundle(digest, 4);
    let task = tokio::spawn(async move { panic_client.fetch(&panic_bundle).await });
    let panic_path = wait_for_destination(&panic_transport).await;
    assert!(task.await.unwrap_err().is_panic());
    assert!(!panic_path.exists());
}
