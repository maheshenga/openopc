use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::config::{EngineStatus, RUNNER_CONTRACT_VERSION, RunnerConfig};
use crate::protocol::RuntimeKind;

pub struct RunnerState {
    node_registered: AtomicBool,
    wasmtime_identity: Option<String>,
    oci_profile_status: EngineStatus,
    requires_wasi: bool,
    requires_oci: bool,
    drain: AtomicBool,
    capacity_total: u16,
    capacity_available: AtomicU16,
}

impl RunnerState {
    pub fn new(config: &RunnerConfig) -> Self {
        Self {
            node_registered: AtomicBool::new(false),
            wasmtime_identity: config.wasmtime_identity.clone(),
            oci_profile_status: config.oci_profile_status,
            requires_wasi: config
                .profiles
                .iter()
                .any(|profile| profile.runtime_kind == RuntimeKind::WasiComponent),
            requires_oci: config
                .profiles
                .iter()
                .any(|profile| profile.runtime_kind == RuntimeKind::OciImage),
            drain: AtomicBool::new(config.drain),
            capacity_total: config.capacity,
            capacity_available: AtomicU16::new(config.capacity),
        }
    }

    pub fn set_node_registered(&self, registered: bool) {
        self.node_registered.store(registered, Ordering::Release);
    }

    pub fn set_drain(&self, drain: bool) {
        self.drain.store(drain, Ordering::Release);
    }

    pub fn set_available_capacity(&self, available: u16) {
        self.capacity_available
            .store(available.min(self.capacity_total), Ordering::Release);
    }

    fn view(&self) -> RunnerReadiness {
        let node_registered = self.node_registered.load(Ordering::Acquire);
        let drain = self.drain.load(Ordering::Acquire);
        let available = self.capacity_available.load(Ordering::Acquire);
        let wasi_ready = !self.requires_wasi || self.wasmtime_identity.is_some();
        let oci_ready = !self.requires_oci || self.oci_profile_status == EngineStatus::Ready;
        let ready = node_registered && !drain && available > 0 && wasi_ready && oci_ready;
        RunnerReadiness {
            status: if ready { "ready" } else { "not_ready" },
            protocol_version: RUNNER_CONTRACT_VERSION,
            node_registration: if node_registered {
                "ready"
            } else {
                "unavailable"
            },
            wasmtime_identity: self.wasmtime_identity.clone(),
            oci_profile_status: engine_status(self.oci_profile_status),
            drain,
            capacity: RunnerCapacity {
                total: self.capacity_total,
                available,
            },
            ready,
        }
    }
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerReadiness {
    status: &'static str,
    protocol_version: u32,
    node_registration: &'static str,
    wasmtime_identity: Option<String>,
    oci_profile_status: &'static str,
    drain: bool,
    capacity: RunnerCapacity,
    #[serde(skip)]
    ready: bool,
}

#[derive(Serialize)]
struct RunnerCapacity {
    total: u16,
    available: u16,
}

pub fn runner_router(state: Arc<RunnerState>) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(readiness))
        .with_state(state)
}

async fn health() -> Json<Health> {
    Json(Health { status: "ok" })
}

async fn readiness(State(state): State<Arc<RunnerState>>) -> impl IntoResponse {
    let view = state.view();
    let status = if view.ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(view))
}

fn engine_status(status: EngineStatus) -> &'static str {
    match status {
        EngineStatus::Ready => "ready",
        EngineStatus::Unavailable => "unavailable",
        EngineStatus::Disabled => "disabled",
    }
}
