use std::sync::Arc;
use std::time::Duration;

use openopc_module_runner::client::{RunnerClient, RunnerClientError};
use openopc_module_runner::config::{RunnerConfig, RunnerConfigError};
use openopc_module_runner::dispatcher::{RunnerDispatcher, WasiClaimRunner};
use openopc_module_runner::service::{RunnerState, runner_router};
use openopc_module_runner::wasi::{CancellationToken, DenyCapabilityBridge};
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::time::{MissedTickBehavior, interval, timeout};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Error)]
enum RunnerError {
    #[error(transparent)]
    Config(#[from] RunnerConfigError),
    #[error(transparent)]
    Client(#[from] RunnerClientError),
    #[error("MODULE_RUNNER_LISTENER_FAILED")]
    Listener,
    #[error("MODULE_RUNNER_SERVER_FAILED")]
    Server,
    #[error("MODULE_RUNNER_TASK_FAILED")]
    Task,
}

#[tokio::main]
async fn main() {
    init_telemetry();
    if let Err(error) = run().await {
        error!(error_code = %error, "module Runner stopped");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), RunnerError> {
    let config = RunnerConfig::from_env()?;
    let client = RunnerClient::new(&config)?;
    let state = Arc::new(RunnerState::new(&config));
    let artifacts = client.runtime_artifact_client();
    let claimed_runner = Arc::new(WasiClaimRunner::new(
        client.clone(),
        artifacts,
        Arc::new(DenyCapabilityBridge),
        config.capacity,
    ));
    let dispatcher = Arc::new(RunnerDispatcher::new(
        Arc::new(client.clone()),
        state.clone(),
        claimed_runner,
    ));
    let listener = TcpListener::bind(config.listen_addr)
        .await
        .map_err(|_| RunnerError::Listener)?;

    let heartbeat_stop = CancellationToken::new();
    let heartbeat_task = tokio::spawn(node_heartbeat_loop(
        client,
        state.clone(),
        config.software_version.clone(),
        config.attestation_digest.clone(),
        heartbeat_stop.clone(),
    ));
    let mut dispatcher_task = tokio::spawn({
        let dispatcher = dispatcher.clone();
        async move { dispatcher.run().await }
    });
    let server_stop = CancellationToken::new();
    let mut server_task = tokio::spawn({
        let server_stop = server_stop.clone();
        let state = state.clone();
        async move {
            let shutdown = async move {
                server_stop.cancelled().await;
            };
            axum::serve(listener, runner_router(state))
                .with_graceful_shutdown(shutdown)
                .await
                .map_err(|_| RunnerError::Server)
        }
    });
    info!(
        listen_addr = %config.listen_addr,
        node_identity = %config.node_identity,
        protocol_version = config.contract_version,
        capacity = config.capacity,
        "module Runner started"
    );

    let server_finished = tokio::select! {
        () = shutdown_signal() => None,
        result = &mut server_task => Some(result),
    };
    state.set_drain(true);
    dispatcher.shutdown();
    heartbeat_stop.cancel();
    let _ = heartbeat_task.await;

    if timeout(config.shutdown_timeout, &mut dispatcher_task)
        .await
        .is_err()
    {
        warn!("module Runner shutdown window expired with leased work still active");
        dispatcher_task.abort();
        let _ = dispatcher_task.await;
    }
    server_stop.cancel();

    match server_finished {
        Some(result) => flatten_task(result),
        None => flatten_task(server_task.await),
    }
}

async fn node_heartbeat_loop(
    client: RunnerClient,
    state: Arc<RunnerState>,
    software_version: String,
    attestation_digest: String,
    stop: CancellationToken,
) {
    let mut heartbeat = interval(Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            _ = heartbeat.tick() => {}
        }
        match client
            .heartbeat_node(&software_version, &attestation_digest)
            .await
        {
            Ok(_) => state.set_node_registered(true),
            Err(error) => {
                state.set_node_registered(false);
                warn!(error_code = %error, "module Runner registration heartbeat failed");
            }
        }
    }
}

async fn shutdown_signal() {
    if tokio::signal::ctrl_c().await.is_err() {
        warn!("module Runner shutdown signal handler failed");
    }
}

fn flatten_task(
    result: Result<Result<(), RunnerError>, tokio::task::JoinError>,
) -> Result<(), RunnerError> {
    result.map_err(|_| RunnerError::Task)?
}

fn init_telemetry() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .json()
        .try_init();
    let _meter = opentelemetry::global::meter("openopc-module-runner");
}
