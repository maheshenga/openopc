use std::collections::VecDeque;
use std::future::{Future, pending};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use openopc_module_runner::client::{RunnerClientError, TrustedClaimFailureCode};
use openopc_module_runner::config::{EngineStatus, RunnerConfig};
use openopc_module_runner::dispatcher::{
    ClaimFuture, ClaimSource, ClaimedExecutionRunner, NoWorkBackoff, RunnerDispatcher,
};
use openopc_module_runner::protocol::{
    ProtocolError, Runtime, RuntimeArtifactReference, RuntimeDescriptorV1, RuntimeKind,
    RuntimeLimits, VerifiedClaim, VerifiedExecutionBundle, WorkEnvelopeLeaseV1,
    WorkEnvelopeResourceCeilingsV1, WorkEnvelopeV1,
};
use openopc_module_runner::service::RunnerState;
use openopc_module_runner::wasi::{CancellationToken, TerminalEvidence};
use tokio::sync::Notify;
use url::Url;
use uuid::Uuid;

fn config(capacity: u16) -> RunnerConfig {
    RunnerConfig {
        control_plane_url: Url::parse("https://control.example.test/").unwrap(),
        control_plane_public_key_file: PathBuf::from("unused-public-key.pem"),
        control_plane_key_id: "test-key".into(),
        node_identity: "runner-test".into(),
        runner_id: Uuid::nil(),
        account_id: Uuid::nil(),
        mtls_certificate_file: PathBuf::from("unused-cert.pem"),
        mtls_private_key_file: PathBuf::from("unused-key.pem"),
        profiles: vec![],
        contract_version: 1,
        software_version: "0.1.0".into(),
        attestation_digest: format!("sha256:{}", "a".repeat(64)),
        capacity,
        drain: false,
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        wasmtime_identity: None,
        oci_profile_status: EngineStatus::Disabled,
        shutdown_timeout: Duration::from_secs(30),
    }
}

fn bundle(id: usize) -> VerifiedExecutionBundle {
    let execution_id = format!("10000000-0000-4000-8000-{id:012}");
    VerifiedExecutionBundle {
        claim: VerifiedClaim {
            envelope: WorkEnvelopeV1 {
                envelope_version: 1,
                execution_id,
                account_id: "20000000-0000-4000-8000-000000000001".into(),
                project_id: "30000000-0000-4000-8000-000000000001".into(),
                installation_id: "40000000-0000-4000-8000-000000000001".into(),
                idempotency_key: format!("dispatcher-{id}"),
                install_revision: 1,
                release_id: "50000000-0000-4000-8000-000000000001".into(),
                release_digest: format!("sha256:{}", "1".repeat(64)),
                consent_revision_id: "60000000-0000-4000-8000-000000000001".into(),
                permission_digest: format!("sha256:{}", "2".repeat(64)),
                runtime_descriptor_id: "70000000-0000-4000-8000-000000000001".into(),
                runtime_descriptor_digest: format!("sha256:{}", "3".repeat(64)),
                input_digest: format!("sha256:{}", "4".repeat(64)),
                runtime_artifact_digest: format!("sha256:{}", "5".repeat(64)),
                runtime_artifact_bytes: 4,
                runtime_kind: RuntimeKind::WasiComponent,
                runtime_profile: "wasmtime-component-v1".into(),
                policy_digest: format!("sha256:{}", "6".repeat(64)),
                kill_switch_generation: 0,
                execution_deadline: "2099-07-30T10:30:00.000Z".into(),
                binding_digest: format!("sha256:{}", "7".repeat(64)),
                resource_ceilings: WorkEnvelopeResourceCeilingsV1 {
                    cpu_millis: 1_000,
                    memory_mi_b: 64,
                    wall_time_ms: 1_000,
                    cost_micro: 0,
                },
                lease: WorkEnvelopeLeaseV1 {
                    id: format!("80000000-0000-4000-8000-{id:012}"),
                    generation: 1,
                    deadline: "2099-07-30T10:00:00.000Z".into(),
                },
                grants: vec![],
            },
            capability_tokens: vec![],
        },
        runtime_descriptor: RuntimeDescriptorV1 {
            descriptor_version: 1,
            runtime: Runtime::WasiComponent {
                component: "runtime/main.wasm".into(),
                world: "openopc:module/module@1.0.0".into(),
                operation: "run".into(),
                imports: vec![],
                limits: RuntimeLimits {
                    cpu_millis: 1_000,
                    fuel: 1_000,
                    memory_mi_b: 64,
                    output_bytes: 1_024,
                    pids: 1,
                    wall_time_ms: 1_000,
                },
            },
        },
        input: br#"{}"#.to_vec(),
        runtime_artifact: RuntimeArtifactReference {
            fetch_path: "module-runtime/artifacts/fetch".into(),
            digest: format!("sha256:{}", "5".repeat(64)),
            bytes: 4,
        },
    }
}

struct FakeClaims {
    outcomes: Mutex<VecDeque<Result<Option<VerifiedExecutionBundle>, RunnerClientError>>>,
    calls: AtomicUsize,
}

impl FakeClaims {
    fn new(
        outcomes: impl IntoIterator<Item = Result<Option<VerifiedExecutionBundle>, RunnerClientError>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            calls: AtomicUsize::new(0),
        })
    }
}

impl ClaimSource for FakeClaims {
    fn claim_next(&self) -> ClaimFuture<'_> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let outcome = self.outcomes.lock().unwrap().pop_front();
        Box::pin(async move {
            match outcome {
                Some(outcome) => outcome,
                None => pending().await,
            }
        })
    }
}

#[derive(Clone, Copy)]
enum RunMode {
    Succeeded,
    Cancelled,
    Failed,
    Panic,
}

struct RecordingRunner {
    mode: RunMode,
    started: AtomicUsize,
    active: AtomicUsize,
    max_active: AtomicUsize,
    release: Notify,
    rejected: AtomicUsize,
}

impl RecordingRunner {
    fn new(mode: RunMode) -> Arc<Self> {
        Arc::new(Self {
            mode,
            started: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            release: Notify::new(),
            rejected: AtomicUsize::new(0),
        })
    }
}

impl ClaimedExecutionRunner for RecordingRunner {
    fn run<'a>(
        &'a self,
        _bundle: VerifiedExecutionBundle,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = TerminalEvidence> + Send + 'a>> {
        Box::pin(async move {
            self.started.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            self.release.notified().await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            match self.mode {
                RunMode::Succeeded => TerminalEvidence::from_code("OK"),
                RunMode::Cancelled => {
                    cancellation.cancel();
                    TerminalEvidence::from_code("EXECUTION_CANCELLED")
                }
                RunMode::Failed => TerminalEvidence::from_code("WASI_TRAP"),
                RunMode::Panic => panic!("injected claimed execution panic"),
            }
        })
    }

    fn reject<'a>(
        &'a self,
        _claim: VerifiedClaim,
        _code: TrustedClaimFailureCode,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            self.rejected.fetch_add(1, Ordering::SeqCst);
        })
    }
}

async fn wait_for(counter: &AtomicUsize, expected: usize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while counter.load(Ordering::SeqCst) < expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn starts_exactly_capacity_workers_and_acquires_only_after_a_verified_bundle() {
    let state = Arc::new(RunnerState::new(&config(3)));
    let empty_claims = FakeClaims::new([Ok(None), Ok(None), Ok(None)]);
    let empty_runner = RecordingRunner::new(RunMode::Succeeded);
    let empty_dispatcher = Arc::new(RunnerDispatcher::new(
        empty_claims.clone(),
        state.clone(),
        empty_runner,
    ));
    let task = tokio::spawn({
        let dispatcher = empty_dispatcher.clone();
        async move { dispatcher.run().await }
    });
    wait_for(&empty_claims.calls, 3).await;
    assert_eq!(state.available_capacity(), 3);
    empty_dispatcher.shutdown();
    task.await.unwrap();

    let state = Arc::new(RunnerState::new(&config(3)));
    let claims = FakeClaims::new([
        Ok(Some(bundle(1))),
        Ok(Some(bundle(2))),
        Ok(Some(bundle(3))),
    ]);
    let runner = RecordingRunner::new(RunMode::Succeeded);
    let dispatcher = Arc::new(RunnerDispatcher::new(
        claims.clone(),
        state.clone(),
        runner.clone(),
    ));
    let task = tokio::spawn({
        let dispatcher = dispatcher.clone();
        async move { dispatcher.run().await }
    });
    wait_for(&runner.started, 3).await;

    assert_eq!(runner.max_active.load(Ordering::SeqCst), 3);
    assert_eq!(state.available_capacity(), 0);
    state.set_drain(true);
    runner.release.notify_waiters();
    task.await.unwrap();
    assert_eq!(state.available_capacity(), 3);
    assert_eq!(claims.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn every_terminal_and_panic_path_restores_capacity() {
    for mode in [
        RunMode::Succeeded,
        RunMode::Cancelled,
        RunMode::Failed,
        RunMode::Panic,
    ] {
        let state = Arc::new(RunnerState::new(&config(1)));
        let claims = FakeClaims::new([Ok(Some(bundle(1)))]);
        let runner = RecordingRunner::new(mode);
        let dispatcher = Arc::new(RunnerDispatcher::new(claims, state.clone(), runner.clone()));
        let task = tokio::spawn({
            let dispatcher = dispatcher.clone();
            async move { dispatcher.run().await }
        });
        wait_for(&runner.started, 1).await;
        state.set_drain(true);
        runner.release.notify_waiters();
        task.await.unwrap();
        assert_eq!(state.available_capacity(), 1);
    }
}

#[tokio::test]
async fn drain_stops_new_claims_and_protocol_failure_stops_all_workers() {
    let drained_state = Arc::new(RunnerState::new(&config(3)));
    drained_state.set_drain(true);
    let drained_claims = FakeClaims::new([]);
    RunnerDispatcher::new(
        drained_claims.clone(),
        drained_state,
        RecordingRunner::new(RunMode::Succeeded),
    )
    .run()
    .await;
    assert_eq!(drained_claims.calls.load(Ordering::SeqCst), 0);

    let state = Arc::new(RunnerState::new(&config(3)));
    let claims = FakeClaims::new([Err(RunnerClientError::Protocol(
        ProtocolError::InvalidSignature,
    ))]);
    let dispatcher = RunnerDispatcher::new(
        claims.clone(),
        state.clone(),
        RecordingRunner::new(RunMode::Succeeded),
    );
    dispatcher.run().await;
    assert!(!state.protocol_ready());
    assert!(claims.calls.load(Ordering::SeqCst) <= 3);
}

#[tokio::test]
async fn trusted_bundle_failure_is_finalized_without_consuming_capacity_or_quarantining() {
    let state = Arc::new(RunnerState::new(&config(1)));
    let trusted_claim = bundle(1).claim;
    let claims = FakeClaims::new([Err(RunnerClientError::TrustedClaimBundle {
        claim: Box::new(trusted_claim),
        code: TrustedClaimFailureCode::InputDigestMismatch,
    })]);
    let runner = RecordingRunner::new(RunMode::Succeeded);
    let dispatcher = Arc::new(RunnerDispatcher::new(claims, state.clone(), runner.clone()));
    let task = tokio::spawn({
        let dispatcher = dispatcher.clone();
        async move { dispatcher.run().await }
    });

    wait_for(&runner.rejected, 1).await;
    state.set_drain(true);
    dispatcher.shutdown();
    task.await.unwrap();

    assert_eq!(state.available_capacity(), 1);
    assert!(state.protocol_ready());
}

#[test]
fn no_work_backoff_is_bounded_deterministic_and_resets_after_a_claim() {
    let caps = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];
    let mut backoff = NoWorkBackoff::new(7);
    let first: Vec<_> = caps
        .into_iter()
        .map(|cap| {
            let delay = backoff.next_delay();
            assert!(delay > Duration::ZERO);
            assert!(delay <= Duration::from_millis(cap));
            delay
        })
        .collect();
    backoff.reset();
    assert_eq!(backoff.next_delay(), first[0]);
}
