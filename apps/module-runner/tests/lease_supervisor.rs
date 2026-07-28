use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use openopc_module_runner::client::{
    HeartbeatExecution, HeartbeatExecutionState, HeartbeatLease, HeartbeatLeaseResponse,
    RunnerClientError,
};
use openopc_module_runner::lease::{LeaseHeartbeat, LeaseSupervisor, LeaseSupervisorConfig};
use openopc_module_runner::protocol::{
    RuntimeKind, VerifiedClaim, WorkEnvelopeLeaseV1, WorkEnvelopeResourceCeilingsV1, WorkEnvelopeV1,
};
use openopc_module_runner::wasi::CancellationToken;
use tokio::sync::Notify;

type HeartbeatFuture<'a> =
    Pin<Box<dyn Future<Output = Result<HeartbeatLeaseResponse, RunnerClientError>> + Send + 'a>>;

fn at(second: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, second).unwrap()
}

fn claim(lease_deadline: DateTime<Utc>) -> VerifiedClaim {
    VerifiedClaim {
        envelope: WorkEnvelopeV1 {
            envelope_version: 1,
            execution_id: "10000000-0000-4000-8000-000000000001".into(),
            account_id: "10000000-0000-4000-8000-000000000002".into(),
            project_id: "10000000-0000-4000-8000-000000000003".into(),
            installation_id: "10000000-0000-4000-8000-000000000004".into(),
            idempotency_key: "lease-supervisor-test".into(),
            install_revision: 1,
            release_id: "10000000-0000-4000-8000-000000000005".into(),
            release_digest: format!("sha256:{}", "1".repeat(64)),
            consent_revision_id: "10000000-0000-4000-8000-000000000006".into(),
            permission_digest: format!("sha256:{}", "2".repeat(64)),
            runtime_descriptor_id: "10000000-0000-4000-8000-000000000007".into(),
            runtime_descriptor_digest: format!("sha256:{}", "3".repeat(64)),
            input_digest: format!("sha256:{}", "4".repeat(64)),
            runtime_artifact_digest: format!("sha256:{}", "5".repeat(64)),
            runtime_artifact_bytes: 4,
            runtime_kind: RuntimeKind::WasiComponent,
            runtime_profile: "wasmtime-component-v1".into(),
            policy_digest: format!("sha256:{}", "6".repeat(64)),
            kill_switch_generation: 0,
            execution_deadline: at(59).to_rfc3339(),
            binding_digest: format!("sha256:{}", "7".repeat(64)),
            resource_ceilings: WorkEnvelopeResourceCeilingsV1 {
                cpu_millis: 1_000,
                memory_mi_b: 64,
                wall_time_ms: 1_000,
                cost_micro: 0,
            },
            lease: WorkEnvelopeLeaseV1 {
                id: "10000000-0000-4000-8000-000000000008".into(),
                generation: 1,
                deadline: lease_deadline.to_rfc3339(),
            },
            grants: vec![],
        },
        capability_tokens: vec![],
    }
}

fn heartbeat(state: HeartbeatExecutionState, deadline: DateTime<Utc>) -> HeartbeatLeaseResponse {
    HeartbeatLeaseResponse {
        execution: HeartbeatExecution {
            execution_id: "10000000-0000-4000-8000-000000000001".into(),
            state,
        },
        lease: HeartbeatLease {
            lease_id: "10000000-0000-4000-8000-000000000008".into(),
            execution_id: "10000000-0000-4000-8000-000000000001".into(),
            generation: 1,
            deadline_at: deadline.to_rfc3339(),
            released_at: None,
        },
    }
}

struct FakeHeartbeat {
    outcomes: Mutex<VecDeque<Result<HeartbeatLeaseResponse, RunnerClientError>>>,
    calls: AtomicUsize,
    first_call_entered: Notify,
    release_first_call: Notify,
    block_first_call: bool,
}

impl FakeHeartbeat {
    fn new(
        outcomes: impl IntoIterator<Item = Result<HeartbeatLeaseResponse, RunnerClientError>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            calls: AtomicUsize::new(0),
            first_call_entered: Notify::new(),
            release_first_call: Notify::new(),
            block_first_call: false,
        })
    }

    fn blocking_first(
        outcomes: impl IntoIterator<Item = Result<HeartbeatLeaseResponse, RunnerClientError>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            calls: AtomicUsize::new(0),
            first_call_entered: Notify::new(),
            release_first_call: Notify::new(),
            block_first_call: true,
        })
    }
}

impl LeaseHeartbeat for FakeHeartbeat {
    fn heartbeat<'a>(&'a self, _claim: &'a VerifiedClaim) -> HeartbeatFuture<'a> {
        Box::pin(async move {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 && self.block_first_call {
                self.first_call_entered.notify_one();
                self.release_first_call.notified().await;
            }
            self.outcomes
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Err(RunnerClientError::Transport))
        })
    }
}

fn config(now: Arc<Mutex<DateTime<Utc>>>) -> LeaseSupervisorConfig {
    LeaseSupervisorConfig {
        heartbeat_interval: Duration::from_secs(10),
        now: Arc::new(move || *now.lock().unwrap()),
    }
}

async fn advance(now: &Arc<Mutex<DateTime<Utc>>>, duration: Duration) {
    *now.lock().unwrap() += chrono::Duration::from_std(duration).unwrap();
    tokio::time::advance(duration).await;
    tokio::task::yield_now().await;
}

#[tokio::test(start_paused = true)]
async fn heartbeats_every_ten_seconds_skips_missed_ticks_and_refreshes_deadline() {
    let now = Arc::new(Mutex::new(at(0)));
    let transport = FakeHeartbeat::blocking_first([
        Ok(heartbeat(HeartbeatExecutionState::Running, at(55))),
        Ok(heartbeat(HeartbeatExecutionState::Running, at(58))),
    ]);
    let cancellation = CancellationToken::new();
    let stop = CancellationToken::new();
    let supervisor = LeaseSupervisor::with_config(
        transport.clone(),
        claim(at(50)),
        cancellation.clone(),
        config(now.clone()),
    )
    .unwrap();
    let authority = supervisor.authority();
    let task = tokio::spawn(supervisor.run(stop.clone()));

    advance(&now, Duration::from_secs(10)).await;
    transport.first_call_entered.notified().await;
    advance(&now, Duration::from_secs(25)).await;
    transport.release_first_call.notify_one();
    tokio::task::yield_now().await;

    let after_release = transport.calls.load(Ordering::SeqCst);
    assert!((1..=2).contains(&after_release));
    advance(&now, Duration::from_secs(4)).await;
    assert_eq!(transport.calls.load(Ordering::SeqCst), after_release);
    if after_release == 1 {
        assert_eq!(authority.last_confirmed_deadline(), at(55));
        advance(&now, Duration::from_secs(1)).await;
    }
    assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    assert_eq!(authority.last_confirmed_deadline(), at(58));
    assert!(!cancellation.is_cancelled());

    stop.cancel();
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn terminal_or_fenced_responses_cancel_immediately() {
    for outcome in [
        Ok(heartbeat(HeartbeatExecutionState::Cancelled, at(30))),
        Ok(heartbeat(HeartbeatExecutionState::Succeeded, at(30))),
        Ok(heartbeat(HeartbeatExecutionState::Failed, at(30))),
        Err(RunnerClientError::Status(404)),
        Err(RunnerClientError::Status(409)),
    ] {
        let now = Arc::new(Mutex::new(at(0)));
        let transport = FakeHeartbeat::new([outcome]);
        let cancellation = CancellationToken::new();
        let supervisor = LeaseSupervisor::with_config(
            transport,
            claim(at(30)),
            cancellation.clone(),
            config(now.clone()),
        )
        .unwrap();
        let authority = supervisor.authority();
        let task = tokio::spawn(supervisor.run(CancellationToken::new()));

        advance(&now, Duration::from_secs(10)).await;
        task.await.unwrap();
        assert!(cancellation.is_cancelled());
        assert!(!authority.is_live());
    }
}

#[tokio::test(start_paused = true)]
async fn transport_failure_is_tolerated_only_until_the_last_confirmed_deadline() {
    let now = Arc::new(Mutex::new(at(0)));
    let transport = FakeHeartbeat::new([
        Err(RunnerClientError::Transport),
        Err(RunnerClientError::Status(503)),
        Err(RunnerClientError::Transport),
    ]);
    let cancellation = CancellationToken::new();
    let supervisor = LeaseSupervisor::with_config(
        transport,
        claim(at(25)),
        cancellation.clone(),
        config(now.clone()),
    )
    .unwrap();
    let authority = supervisor.authority();
    let task = tokio::spawn(supervisor.run(CancellationToken::new()));

    advance(&now, Duration::from_secs(10)).await;
    assert!(!cancellation.is_cancelled());
    advance(&now, Duration::from_secs(10)).await;
    assert!(!cancellation.is_cancelled());
    advance(&now, Duration::from_secs(10)).await;

    task.await.unwrap();
    assert!(cancellation.is_cancelled());
    assert!(!authority.is_live());
}

#[tokio::test(start_paused = true)]
async fn a_stalled_heartbeat_cannot_outlive_the_confirmed_deadline() {
    let now = Arc::new(Mutex::new(at(0)));
    let transport =
        FakeHeartbeat::blocking_first([Ok(heartbeat(HeartbeatExecutionState::Running, at(55)))]);
    let cancellation = CancellationToken::new();
    let supervisor = LeaseSupervisor::with_config(
        transport.clone(),
        claim(at(25)),
        cancellation.clone(),
        config(now.clone()),
    )
    .unwrap();
    let authority = supervisor.authority();
    let task = tokio::spawn(supervisor.run(CancellationToken::new()));

    advance(&now, Duration::from_secs(10)).await;
    transport.first_call_entered.notified().await;
    advance(&now, Duration::from_secs(15)).await;

    task.await.unwrap();
    assert!(cancellation.is_cancelled());
    assert!(!authority.is_live());
}
