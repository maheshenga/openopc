use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use thiserror::Error;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};

use crate::client::{
    HeartbeatExecutionState, HeartbeatLeaseResponse, RunnerClient, RunnerClientError,
};
use crate::protocol::VerifiedClaim;
use crate::wasi::CancellationToken;

pub type LeaseHeartbeatFuture<'a> =
    Pin<Box<dyn Future<Output = Result<HeartbeatLeaseResponse, RunnerClientError>> + Send + 'a>>;

pub trait LeaseHeartbeat: Send + Sync {
    fn heartbeat<'a>(&'a self, claim: &'a VerifiedClaim) -> LeaseHeartbeatFuture<'a>;
}

impl LeaseHeartbeat for RunnerClient {
    fn heartbeat<'a>(&'a self, claim: &'a VerifiedClaim) -> LeaseHeartbeatFuture<'a> {
        Box::pin(RunnerClient::heartbeat(self, claim))
    }
}

#[derive(Clone)]
pub struct LeaseSupervisorConfig {
    pub heartbeat_interval: Duration,
    pub now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

impl Default for LeaseSupervisorConfig {
    fn default() -> Self {
        Self {
            heartbeat_interval: Duration::from_secs(10),
            now: Arc::new(Utc::now),
        }
    }
}

#[derive(Debug, Error)]
pub enum LeaseSupervisorError {
    #[error("RUNNER_LEASE_CONFIGURATION_INVALID")]
    Configuration,
}

#[derive(Clone)]
pub struct LeaseAuthority {
    live: Arc<AtomicBool>,
    last_confirmed_deadline: Arc<Mutex<DateTime<Utc>>>,
}

impl LeaseAuthority {
    pub fn is_live(&self) -> bool {
        self.live.load(Ordering::Acquire)
    }

    pub fn last_confirmed_deadline(&self) -> DateTime<Utc> {
        *self
            .last_confirmed_deadline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn refresh(&self, deadline: DateTime<Utc>) {
        *self
            .last_confirmed_deadline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = deadline;
    }

    fn revoke(&self) {
        self.live.store(false, Ordering::Release);
    }
}

pub struct LeaseSupervisor {
    heartbeat: Arc<dyn LeaseHeartbeat>,
    claim: VerifiedClaim,
    cancellation: CancellationToken,
    config: LeaseSupervisorConfig,
    execution_deadline: DateTime<Utc>,
    authority: LeaseAuthority,
}

impl LeaseSupervisor {
    pub fn new(
        heartbeat: Arc<dyn LeaseHeartbeat>,
        claim: VerifiedClaim,
        cancellation: CancellationToken,
    ) -> Result<Self, LeaseSupervisorError> {
        Self::with_config(
            heartbeat,
            claim,
            cancellation,
            LeaseSupervisorConfig::default(),
        )
    }

    pub fn with_config(
        heartbeat: Arc<dyn LeaseHeartbeat>,
        claim: VerifiedClaim,
        cancellation: CancellationToken,
        config: LeaseSupervisorConfig,
    ) -> Result<Self, LeaseSupervisorError> {
        if config.heartbeat_interval.is_zero() {
            return Err(LeaseSupervisorError::Configuration);
        }
        let lease_deadline = parse_deadline(&claim.envelope.lease.deadline)?;
        let execution_deadline = parse_deadline(&claim.envelope.execution_deadline)?;
        let authority = LeaseAuthority {
            live: Arc::new(AtomicBool::new(true)),
            last_confirmed_deadline: Arc::new(Mutex::new(lease_deadline.min(execution_deadline))),
        };
        Ok(Self {
            heartbeat,
            claim,
            cancellation,
            config,
            execution_deadline,
            authority,
        })
    }

    pub fn authority(&self) -> LeaseAuthority {
        self.authority.clone()
    }

    pub async fn run(self, stop: CancellationToken) {
        let mut heartbeat = interval_at(
            Instant::now() + self.config.heartbeat_interval,
            self.config.heartbeat_interval,
        );
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            let Some(remaining) = remaining_until(
                self.authority.last_confirmed_deadline(),
                (self.config.now)(),
            ) else {
                self.lose_authority();
                return;
            };
            tokio::select! {
                biased;
                () = stop.cancelled() => return,
                () = sleep(remaining) => {
                    self.lose_authority();
                    return;
                }
                _ = heartbeat.tick() => {}
            }

            let Some(remaining) = remaining_until(
                self.authority.last_confirmed_deadline(),
                (self.config.now)(),
            ) else {
                self.lose_authority();
                return;
            };
            let heartbeat_request = self.heartbeat.heartbeat(&self.claim);
            tokio::pin!(heartbeat_request);
            let result = tokio::select! {
                biased;
                () = stop.cancelled() => return,
                () = sleep(remaining) => {
                    self.lose_authority();
                    return;
                }
                result = &mut heartbeat_request => result,
            };

            match result {
                Ok(response) if live_response(&response) => {
                    let Ok(deadline) = DateTime::parse_from_rfc3339(&response.lease.deadline_at)
                        .map(|deadline| deadline.with_timezone(&Utc))
                    else {
                        self.lose_authority();
                        return;
                    };
                    let deadline = deadline.min(self.execution_deadline);
                    if deadline <= (self.config.now)() {
                        self.lose_authority();
                        return;
                    }
                    self.authority.refresh(deadline);
                }
                Ok(_) => {
                    self.lose_authority();
                    return;
                }
                Err(error) if retryable_heartbeat_error(&error) => {
                    if (self.config.now)() >= self.authority.last_confirmed_deadline() {
                        self.lose_authority();
                        return;
                    }
                }
                Err(_) => {
                    self.lose_authority();
                    return;
                }
            }
        }
    }

    fn lose_authority(&self) {
        self.authority.revoke();
        self.cancellation.cancel();
    }
}

fn parse_deadline(value: &str) -> Result<DateTime<Utc>, LeaseSupervisorError> {
    DateTime::parse_from_rfc3339(value)
        .map(|deadline| deadline.with_timezone(&Utc))
        .map_err(|_| LeaseSupervisorError::Configuration)
}

fn remaining_until(deadline: DateTime<Utc>, now: DateTime<Utc>) -> Option<Duration> {
    deadline
        .signed_duration_since(now)
        .to_std()
        .ok()
        .filter(|remaining| !remaining.is_zero())
}

fn live_response(response: &HeartbeatLeaseResponse) -> bool {
    response.lease.released_at.is_none()
        && matches!(
            response.execution.state,
            HeartbeatExecutionState::Leased | HeartbeatExecutionState::Running
        )
}

fn retryable_heartbeat_error(error: &RunnerClientError) -> bool {
    matches!(error, RunnerClientError::Transport)
        || matches!(error, RunnerClientError::Status(status) if (500..600).contains(status))
}
