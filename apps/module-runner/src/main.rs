use std::sync::Arc;
use std::time::Duration;

use openopc_module_runner::client::{RunnerClient, RunnerClientError};
use openopc_module_runner::config::{RunnerConfig, RunnerConfigError};
use openopc_module_runner::service::{RunnerState, runner_router};
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::time::{MissedTickBehavior, interval};
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
    let listener = TcpListener::bind(config.listen_addr)
        .await
        .map_err(|_| RunnerError::Listener)?;

    tokio::spawn(node_heartbeat_loop(
        client,
        state.clone(),
        config.software_version.clone(),
        config.attestation_digest.clone(),
    ));
    info!(
        listen_addr = %config.listen_addr,
        node_identity = %config.node_identity,
        protocol_version = config.contract_version,
        "module Runner shell started"
    );
    axum::serve(listener, runner_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|_| RunnerError::Server)
}

async fn node_heartbeat_loop(
    client: RunnerClient,
    state: Arc<RunnerState>,
    software_version: String,
    attestation_digest: String,
) {
    let mut heartbeat = interval(Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        heartbeat.tick().await;
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

fn init_telemetry() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .json()
        .try_init();
    let _meter = opentelemetry::global::meter("openopc-module-runner");
}
