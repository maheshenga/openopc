use std::env;
use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ed25519_dalek::VerifyingKey;
use ed25519_dalek::pkcs8::DecodePublicKey;
use openopc_module_runner::client::{
    ArtifactFetchResponse, ArtifactTransportFuture, ControlPlaneRequest, ControlPlaneResponse,
    ControlPlaneTransport, RunnerClient, RunnerClientError, RuntimeArtifactFetchRequest,
    TransportFuture,
};
use openopc_module_runner::config::{EngineStatus, RunnerConfig, RunnerProfile};
use openopc_module_runner::dispatcher::{RunnerDispatcher, WasiClaimRunner};
use openopc_module_runner::protocol::RuntimeKind;
use openopc_module_runner::service::RunnerState;
use openopc_module_runner::wasi::DenyCapabilityBridge;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::{Client, Url};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;
use uuid::Uuid;

const CLAIM_PATH: &str = "module-runtime/claims/next";
const FINALIZE_PATH: &str = "module-runtime/finalize";

#[derive(Default)]
struct TransportStats {
    claim_200: AtomicUsize,
    claim_204: AtomicUsize,
    envelope_count: AtomicUsize,
    token_count: AtomicUsize,
    finalize_503: AtomicUsize,
    finalize_200: AtomicUsize,
}

impl TransportStats {
    fn value(counter: &AtomicUsize) -> usize {
        counter.load(Ordering::SeqCst)
    }

    fn observe(&self, path: &str, status: u16, body: &[u8]) {
        if path == CLAIM_PATH {
            match status {
                200 => {
                    self.claim_200.fetch_add(1, Ordering::SeqCst);
                    if let Ok(value) = serde_json::from_slice::<Value>(body) {
                        if value
                            .get("signedEnvelope")
                            .and_then(Value::as_str)
                            .is_some()
                        {
                            self.envelope_count.fetch_add(1, Ordering::SeqCst);
                        }
                        if let Some(tokens) =
                            value.get("capabilityTokens").and_then(Value::as_array)
                        {
                            self.token_count.fetch_add(tokens.len(), Ordering::SeqCst);
                        }
                    }
                }
                204 => {
                    self.claim_204.fetch_add(1, Ordering::SeqCst);
                }
                _ => {}
            }
        }
        if path == FINALIZE_PATH {
            match status {
                200 => {
                    self.finalize_200.fetch_add(1, Ordering::SeqCst);
                }
                503 => {
                    self.finalize_503.fetch_add(1, Ordering::SeqCst);
                }
                _ => {}
            }
        }
    }
}

struct LiveHttpTransport {
    base_url: Url,
    http: Client,
    stats: Arc<TransportStats>,
    terminal: watch::Sender<bool>,
}

impl LiveHttpTransport {
    fn new(base_url: Url, stats: Arc<TransportStats>, terminal: watch::Sender<bool>) -> Self {
        Self {
            base_url,
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()
                .expect("test HTTP client must build"),
            stats,
            terminal,
        }
    }

    fn request<'a>(
        &'a self,
        path: &'a str,
        runner_id: &'a str,
        account_id: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<reqwest::Response, RunnerClientError>> + Send + 'a>>
    {
        Box::pin(async move {
            let url = self
                .base_url
                .join(path)
                .map_err(|_| RunnerClientError::Configuration)?;
            self.http
                .post(url)
                .header("x-openopc-runner-id", runner_id)
                .header("x-openopc-runner-account-id", account_id)
                .json(body)
                .send()
                .await
                .map_err(|_| RunnerClientError::Transport)
        })
    }
}

impl ControlPlaneTransport for LiveHttpTransport {
    fn post<'a>(&'a self, request: ControlPlaneRequest) -> TransportFuture<'a> {
        Box::pin(async move {
            let response = self
                .request(
                    &request.path,
                    &request.runner_id,
                    &request.account_id,
                    &request.body,
                )
                .await?;
            let status = response.status().as_u16();
            let body = response
                .bytes()
                .await
                .map_err(|_| RunnerClientError::Transport)?
                .to_vec();
            self.stats.observe(&request.path, status, &body);
            if request.path == FINALIZE_PATH && status == 200 {
                let _ = self.terminal.send(true);
            }
            Ok(ControlPlaneResponse { status, body })
        })
    }

    fn fetch_to<'a>(&'a self, request: RuntimeArtifactFetchRequest) -> ArtifactTransportFuture<'a> {
        Box::pin(async move {
            let mut response = self
                .request(
                    &request.path,
                    &request.runner_id,
                    &request.account_id,
                    &request.body,
                )
                .await?;
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

struct LiveConfig {
    server_url: Url,
    account_id: Uuid,
    runner_a_id: Uuid,
    runner_b_id: Uuid,
    public_key: VerifyingKey,
    key_id: String,
    deadline_ms: u64,
}

impl LiveConfig {
    fn from_env() -> Self {
        let public_key_pem = required("OPENOPC_DISPATCH_TEST_PUBLIC_KEY_PEM");
        Self {
            server_url: required("OPENOPC_DISPATCH_TEST_SERVER_URL")
                .parse()
                .expect("test server URL must be valid"),
            account_id: required("OPENOPC_DISPATCH_TEST_ACCOUNT_ID")
                .parse()
                .expect("test account id must be a UUID"),
            runner_a_id: required("OPENOPC_DISPATCH_TEST_RUNNER_A_ID")
                .parse()
                .expect("test Runner A id must be a UUID"),
            runner_b_id: required("OPENOPC_DISPATCH_TEST_RUNNER_B_ID")
                .parse()
                .expect("test Runner B id must be a UUID"),
            public_key: VerifyingKey::from_public_key_pem(&public_key_pem)
                .expect("test public key must be Ed25519 SPKI PEM"),
            key_id: required("OPENOPC_DISPATCH_TEST_KEY_ID"),
            deadline_ms: required("OPENOPC_DISPATCH_TEST_DEADLINE_MS")
                .parse()
                .expect("test deadline must be epoch milliseconds"),
        }
    }
}

fn required(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("missing test-scoped environment variable {name}"))
}

fn runner_config(server_url: Url, account_id: Uuid, runner_id: Uuid) -> RunnerConfig {
    RunnerConfig {
        control_plane_url: server_url,
        control_plane_public_key_file: PathBuf::new(),
        control_plane_key_id: "dispatch-live-ed25519-v1".into(),
        node_identity: format!("dispatch-live-{runner_id}"),
        runner_id,
        account_id,
        mtls_certificate_file: PathBuf::new(),
        mtls_private_key_file: PathBuf::new(),
        profiles: vec![RunnerProfile {
            runtime_kind: RuntimeKind::WasiComponent,
            profile_name: "openopc-wasi-v1".into(),
        }],
        contract_version: 1,
        software_version: "dispatch-live-test".into(),
        attestation_digest: format!("sha256:{}", "c".repeat(64)),
        capacity: 1,
        drain: false,
        listen_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
        wasmtime_identity: Some("wasmtime-47.0.2".into()),
        oci_profile_status: EngineStatus::Disabled,
        shutdown_timeout: Duration::from_secs(10),
    }
}

fn dispatcher(
    config: RunnerConfig,
    public_key: VerifyingKey,
    key_id: String,
    stats: Arc<TransportStats>,
    terminal: watch::Sender<bool>,
) -> Arc<RunnerDispatcher> {
    let transport = Arc::new(LiveHttpTransport::new(
        config.control_plane_url.clone(),
        stats,
        terminal,
    ));
    let client = RunnerClient::with_transport(
        config.runner_id,
        config.account_id,
        public_key,
        key_id,
        transport,
    );
    let state = Arc::new(RunnerState::new(&config));
    let claimed_runner = Arc::new(WasiClaimRunner::new(
        client.clone(),
        client.runtime_artifact_client(),
        Arc::new(DenyCapabilityBridge),
        1,
    ));
    Arc::new(RunnerDispatcher::new(
        Arc::new(client),
        state,
        claimed_runner,
    ))
}

fn remaining(deadline_ms: u64) -> Duration {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after Unix epoch")
        .as_millis() as u64;
    Duration::from_millis(deadline_ms.saturating_sub(now))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the Bun-owned PostgreSQL and module-runtime API harness"]
async fn two_capacity_one_dispatchers_execute_and_finalize_once() {
    let config = LiveConfig::from_env();
    let (terminal_tx, mut terminal_rx) = watch::channel(false);
    let stats_a = Arc::new(TransportStats::default());
    let stats_b = Arc::new(TransportStats::default());
    let dispatcher_a = dispatcher(
        runner_config(
            config.server_url.clone(),
            config.account_id,
            config.runner_a_id,
        ),
        config.public_key,
        config.key_id.clone(),
        stats_a.clone(),
        terminal_tx.clone(),
    );
    let dispatcher_b = dispatcher(
        runner_config(config.server_url, config.account_id, config.runner_b_id),
        config.public_key,
        config.key_id,
        stats_b.clone(),
        terminal_tx,
    );
    let task_a = tokio::spawn({
        let dispatcher = dispatcher_a.clone();
        async move { dispatcher.run().await }
    });
    let task_b = tokio::spawn({
        let dispatcher = dispatcher_b.clone();
        async move { dispatcher.run().await }
    });

    if !*terminal_rx.borrow() {
        tokio::time::timeout(remaining(config.deadline_ms), terminal_rx.changed())
            .await
            .expect("single execution did not reach terminal state before the live-test deadline")
            .expect("terminal signal channel closed unexpectedly");
    }
    assert!(*terminal_rx.borrow(), "terminal signal must report success");
    dispatcher_a.shutdown();
    dispatcher_b.shutdown();
    tokio::time::timeout(Duration::from_secs(10), async {
        task_a.await.expect("Runner A dispatcher task must join");
        task_b.await.expect("Runner B dispatcher task must join");
    })
    .await
    .expect("dispatchers must stop after terminal completion");

    let claims_200 =
        TransportStats::value(&stats_a.claim_200) + TransportStats::value(&stats_b.claim_200);
    let claims_204 =
        TransportStats::value(&stats_a.claim_204) + TransportStats::value(&stats_b.claim_204);
    let finalize_503 =
        TransportStats::value(&stats_a.finalize_503) + TransportStats::value(&stats_b.finalize_503);
    let finalize_200 =
        TransportStats::value(&stats_a.finalize_200) + TransportStats::value(&stats_b.finalize_200);
    assert_eq!(
        claims_200, 1,
        "exactly one Runner may receive a claim bundle"
    );
    assert!(claims_204 >= 1, "the losing Runner must observe HTTP 204");
    assert_eq!(
        finalize_503, 1,
        "the winning Runner must observe one transient finalize failure"
    );
    assert_eq!(
        finalize_200, 1,
        "the winning Runner must successfully retry finalize exactly once"
    );

    let (winner, loser) = if TransportStats::value(&stats_a.claim_200) == 1 {
        (&stats_a, &stats_b)
    } else {
        (&stats_b, &stats_a)
    };
    assert_eq!(TransportStats::value(&winner.envelope_count), 1);
    assert_eq!(TransportStats::value(&winner.token_count), 1);
    assert_eq!(TransportStats::value(&loser.claim_200), 0);
    assert!(TransportStats::value(&loser.claim_204) >= 1);
    assert_eq!(TransportStats::value(&loser.envelope_count), 0);
    assert_eq!(TransportStats::value(&loser.token_count), 0);

    println!(
        "{}",
        json!({
            "event": "dispatcher_live_summary",
            "claims_200": claims_200,
            "claims_204": claims_204,
            "finalize_503": finalize_503,
            "finalize_200": finalize_200,
            "losing_runner_token_count": TransportStats::value(&loser.token_count),
            "losing_runner_envelope_count": TransportStats::value(&loser.envelope_count),
        })
    );
}
