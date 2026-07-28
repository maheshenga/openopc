use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use serde_json::json;
use tokio::task::JoinSet;
use tracing::warn;

use crate::client::{
    FinalizeInput, RunnerClient, RunnerClientError, RuntimeArtifactClient, TerminalOutcome,
    TrustedClaimFailureCode,
};
use crate::lease::{LeaseSupervisor, LeaseSupervisorConfig};
use crate::protocol::{Runtime, VerifiedClaim, VerifiedExecutionBundle};
use crate::service::RunnerState;
use crate::wasi::{
    CancellationToken, CapabilityBridge, TerminalEvidence, WasiExecutionOutcome, WasiExecutor,
    WasiExecutorConfig, WasiInvocation,
};

pub type ClaimFuture<'a> = Pin<
    Box<
        dyn Future<Output = Result<Option<VerifiedExecutionBundle>, RunnerClientError>> + Send + 'a,
    >,
>;

pub trait ClaimSource: Send + Sync {
    fn claim_next(&self) -> ClaimFuture<'_>;
}

impl ClaimSource for RunnerClient {
    fn claim_next(&self) -> ClaimFuture<'_> {
        Box::pin(RunnerClient::claim_next(self))
    }
}

pub trait ClaimedExecutionRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        bundle: VerifiedExecutionBundle,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = TerminalEvidence> + Send + 'a>>;

    fn reject<'a>(
        &'a self,
        _claim: VerifiedClaim,
        _code: TrustedClaimFailureCode,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async {})
    }
}

#[derive(Clone)]
pub struct WasiClaimRunnerConfig {
    pub executor: WasiExecutorConfig,
    pub lease: LeaseSupervisorConfig,
    pub finalize_initial_backoff: Duration,
    pub finalize_max_backoff: Duration,
}

impl Default for WasiClaimRunnerConfig {
    fn default() -> Self {
        Self {
            executor: WasiExecutorConfig::default(),
            lease: LeaseSupervisorConfig::default(),
            finalize_initial_backoff: Duration::from_millis(250),
            finalize_max_backoff: Duration::from_secs(5),
        }
    }
}

pub struct WasiClaimRunner {
    client: RunnerClient,
    artifacts: RuntimeArtifactClient,
    bridge: Arc<dyn CapabilityBridge>,
    config: WasiClaimRunnerConfig,
}

impl WasiClaimRunner {
    pub fn new(
        client: RunnerClient,
        artifacts: RuntimeArtifactClient,
        bridge: Arc<dyn CapabilityBridge>,
        max_concurrency: u16,
    ) -> Self {
        Self::with_config(
            client,
            artifacts,
            bridge,
            WasiClaimRunnerConfig {
                executor: WasiExecutorConfig {
                    max_concurrency,
                    ..WasiExecutorConfig::default()
                },
                ..WasiClaimRunnerConfig::default()
            },
        )
    }

    pub fn with_config(
        client: RunnerClient,
        artifacts: RuntimeArtifactClient,
        bridge: Arc<dyn CapabilityBridge>,
        config: WasiClaimRunnerConfig,
    ) -> Self {
        Self {
            client,
            artifacts,
            bridge,
            config,
        }
    }

    async fn run_bundle(
        &self,
        bundle: VerifiedExecutionBundle,
        cancellation: CancellationToken,
    ) -> TerminalEvidence {
        let artifact = match self.artifacts.fetch(&bundle).await {
            Ok(artifact) => artifact,
            Err(error) => return TerminalEvidence::from_code(artifact_error_code(&error)),
        };
        let component_bytes = match tokio::fs::read(artifact.path()).await {
            Ok(bytes) => bytes,
            Err(_) => return TerminalEvidence::from_code("RUNNER_ARTIFACT_UNAVAILABLE"),
        };
        let Runtime::WasiComponent { component, .. } = &bundle.runtime_descriptor.runtime else {
            return TerminalEvidence::from_code("RUNNER_DESCRIPTOR_DIGEST_MISMATCH");
        };
        if let Err(error) = self
            .client
            .append_evidence(
                &bundle.claim,
                "runtime_started",
                json!({
                    "artifactBytes": artifact.bytes(),
                    "artifactDigest": artifact.digest(),
                    "runtime": "wasi-component",
                    "runtimeProfile": bundle.claim.envelope.runtime_profile,
                }),
            )
            .await
        {
            if matches!(error, RunnerClientError::Status(404 | 409)) {
                cancellation.cancel();
                return TerminalEvidence::from_code("EXECUTION_CANCELLED");
            }
            return TerminalEvidence::from_code("RUNNER_EVIDENCE_UNAVAILABLE");
        }

        let supervisor = match LeaseSupervisor::with_config(
            Arc::new(self.client.clone()),
            bundle.claim.clone(),
            cancellation.clone(),
            self.config.lease.clone(),
        ) {
            Ok(supervisor) => supervisor,
            Err(_) => return TerminalEvidence::from_code("RUNNER_LEASE_CONFIGURATION_INVALID"),
        };
        let authority = supervisor.authority();
        let supervisor_stop = CancellationToken::new();
        let supervisor_task = tokio::spawn(supervisor.run(supervisor_stop.clone()));

        let invocation = WasiInvocation::new(
            component.clone(),
            component_bytes,
            bundle.input.clone(),
            cancellation,
        );
        let evidence = match WasiExecutor::new(
            self.config.executor.clone(),
            invocation,
            self.bridge.clone(),
        ) {
            Ok(executor) => {
                executor
                    .execute(&bundle.claim, &bundle.runtime_descriptor)
                    .await
            }
            Err(_) => TerminalEvidence::from_code("WASI_ENGINE_CONFIGURATION_INVALID"),
        };
        supervisor_stop.cancel();
        let _ = supervisor_task.await;
        drop(artifact);

        if authority.is_live() {
            let deadline = claim_deadline(&bundle.claim)
                .map(|deadline| deadline.min(authority.last_confirmed_deadline()));
            if let Some(deadline) = deadline {
                self.finalize_with_retry(&bundle.claim, deadline, &evidence)
                    .await;
            }
        }
        evidence
    }

    async fn finalize_with_retry(
        &self,
        claim: &VerifiedClaim,
        deadline: DateTime<Utc>,
        evidence: &TerminalEvidence,
    ) {
        let input = FinalizeInput {
            outcome: terminal_outcome(evidence.outcome),
            evidence_digest: evidence.evidence_digest.clone(),
            evidence: evidence.evidence(),
            usage: json!({
                "fuelConsumed": evidence.usage.fuel_consumed,
                "outputBytes": evidence.usage.output_bytes,
                "wallTimeMs": evidence.usage.wall_time_ms,
            }),
        };
        let max_delay = self
            .config
            .finalize_max_backoff
            .max(Duration::from_millis(1));
        let mut delay = self
            .config
            .finalize_initial_backoff
            .max(Duration::from_millis(1))
            .min(max_delay);
        loop {
            let Ok(remaining) = (deadline - Utc::now()).to_std() else {
                return;
            };
            if remaining.is_zero() {
                return;
            }
            match tokio::time::timeout(remaining, self.client.finalize(claim, input.clone())).await
            {
                Err(_) => return,
                Ok(Ok(_)) => return,
                Ok(Err(error)) if retryable_finalize_error(&error) => {
                    let Ok(remaining) = (deadline - Utc::now()).to_std() else {
                        return;
                    };
                    if remaining.is_zero() {
                        return;
                    }
                    tokio::time::sleep(delay.min(remaining)).await;
                    delay = delay.saturating_mul(2).min(max_delay);
                }
                Ok(Err(_)) => return,
            }
        }
    }
}

impl ClaimedExecutionRunner for WasiClaimRunner {
    fn run<'a>(
        &'a self,
        bundle: VerifiedExecutionBundle,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = TerminalEvidence> + Send + 'a>> {
        Box::pin(self.run_bundle(bundle, cancellation))
    }

    fn reject<'a>(
        &'a self,
        claim: VerifiedClaim,
        code: TrustedClaimFailureCode,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let Some(deadline) = claim_deadline(&claim) else {
                return;
            };
            let evidence = TerminalEvidence::from_code(code.as_str());
            self.finalize_with_retry(&claim, deadline, &evidence).await;
        })
    }
}

fn claim_deadline(claim: &VerifiedClaim) -> Option<DateTime<Utc>> {
    let execution = DateTime::parse_from_rfc3339(&claim.envelope.execution_deadline)
        .ok()?
        .with_timezone(&Utc);
    let lease = DateTime::parse_from_rfc3339(&claim.envelope.lease.deadline)
        .ok()?
        .with_timezone(&Utc);
    Some(execution.min(lease))
}

fn artifact_error_code(error: &RunnerClientError) -> &'static str {
    match error {
        RunnerClientError::ArtifactLimit => "RUNNER_ARTIFACT_LIMIT",
        RunnerClientError::ArtifactDigest
        | RunnerClientError::ArtifactLength
        | RunnerClientError::ArtifactMetadata => "RUNNER_ARTIFACT_DIGEST_MISMATCH",
        _ => "RUNNER_ARTIFACT_UNAVAILABLE",
    }
}

fn terminal_outcome(outcome: WasiExecutionOutcome) -> TerminalOutcome {
    match outcome {
        WasiExecutionOutcome::Succeeded => TerminalOutcome::Succeeded,
        WasiExecutionOutcome::Failed => TerminalOutcome::Failed,
        WasiExecutionOutcome::Cancelled => TerminalOutcome::Cancelled,
    }
}

fn retryable_finalize_error(error: &RunnerClientError) -> bool {
    matches!(error, RunnerClientError::Transport)
        || matches!(error, RunnerClientError::Status(status) if (500..600).contains(status))
}

pub struct NoWorkBackoff {
    worker_seed: u64,
    attempt: usize,
}

impl NoWorkBackoff {
    pub fn new(worker_seed: u64) -> Self {
        Self {
            worker_seed,
            attempt: 0,
        }
    }

    pub fn next_delay(&mut self) -> Duration {
        const CAPS_MS: [u64; 7] = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];
        let cap = CAPS_MS[self.attempt.min(CAPS_MS.len() - 1)];
        let mut value = self
            .worker_seed
            .wrapping_add((self.attempt as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15));
        value ^= value >> 30;
        value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value ^= value >> 27;
        value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
        value ^= value >> 31;
        let jitter_percent = 75 + value % 26;
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_millis((cap * jitter_percent / 100).max(1))
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

pub struct RunnerDispatcher {
    claims: Arc<dyn ClaimSource>,
    state: Arc<RunnerState>,
    runner: Arc<dyn ClaimedExecutionRunner>,
    shutdown: CancellationToken,
}

impl RunnerDispatcher {
    pub fn new(
        claims: Arc<dyn ClaimSource>,
        state: Arc<RunnerState>,
        runner: Arc<dyn ClaimedExecutionRunner>,
    ) -> Self {
        Self {
            claims,
            state,
            runner,
            shutdown: CancellationToken::new(),
        }
    }

    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }

    pub async fn run(&self) {
        let mut workers = JoinSet::new();
        for worker_id in 0..self.state.total_capacity() {
            let claims = self.claims.clone();
            let state = self.state.clone();
            let runner = self.runner.clone();
            let shutdown = self.shutdown.clone();
            workers.spawn(async move {
                worker_loop(u64::from(worker_id), claims, state, runner, shutdown).await;
            });
        }
        while let Some(result) = workers.join_next().await {
            if result.is_err() {
                self.state.set_protocol_ready(false);
                self.shutdown.cancel();
            }
        }
    }
}

async fn worker_loop(
    worker_id: u64,
    claims: Arc<dyn ClaimSource>,
    state: Arc<RunnerState>,
    runner: Arc<dyn ClaimedExecutionRunner>,
    shutdown: CancellationToken,
) {
    let mut backoff = NoWorkBackoff::new(worker_id);
    loop {
        if shutdown.is_cancelled() || state.is_draining() || !state.protocol_ready() {
            return;
        }

        let claimed = tokio::select! {
            () = shutdown.cancelled() => return,
            claimed = claims.claim_next() => claimed,
        };
        match claimed {
            Ok(Some(bundle)) => {
                backoff.reset();
                let Some(_permit) = state.try_acquire_capacity() else {
                    tokio::task::yield_now().await;
                    continue;
                };
                let cancellation = CancellationToken::new();
                if AssertUnwindSafe(runner.run(bundle, cancellation))
                    .catch_unwind()
                    .await
                    .is_err()
                {
                    warn!(worker_id, "claimed module execution panicked");
                }
            }
            Err(RunnerClientError::TrustedClaimBundle { claim, code }) => {
                backoff.reset();
                if AssertUnwindSafe(runner.reject(*claim, code))
                    .catch_unwind()
                    .await
                    .is_err()
                {
                    warn!(worker_id, error_code = %code, "trusted module claim rejection panicked");
                }
            }
            Ok(None) => {
                let delay = backoff.next_delay();
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(delay) => {}
                }
            }
            Err(RunnerClientError::Protocol(error)) => {
                state.set_protocol_ready(false);
                shutdown.cancel();
                warn!(worker_id, error_code = %error, "module claim protocol verification failed");
                return;
            }
            Err(error) => {
                warn!(worker_id, error_code = %error, "module claim request failed");
                let delay = backoff.next_delay();
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
}
