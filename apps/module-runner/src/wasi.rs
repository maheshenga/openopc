pub mod capabilities;
pub mod events;
pub mod limits;

use std::collections::HashSet;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Notify;
use wasmtime::component::{Component, HasSelf, Linker};
use wasmtime::{
    Config, Engine, InstanceAllocationStrategy, PoolingAllocationConfig, Store, Trap,
    UpdateDeadline,
};

use crate::evidence::evidence_digest;
use crate::protocol::{Runtime, RuntimeDescriptorV1, VerifiedClaim};
use limits::{WasiLimitError, WasiStoreLimits};

pub use capabilities::{
    CapabilityBridge, CapabilityBridgeError, CapabilityCredential, CapabilityFuture,
    CapabilityRequest, CapabilityResponse, DenyCapabilityBridge, EgressCapabilityBridge,
    EgressCapabilityBridgeError, EgressTransport, EgressTransportFuture, EgressTransportRequest,
    EgressTransportResponse, ExecutionCapabilities, ReqwestEgressTransport,
};
pub use events::{WasiEvidenceEvent, WasiEvidenceRecorder};

const WASMTIME_VERSION: &str = "47.0.2";
const WORLD: &str = "openopc:module/module@1.0.0";
const OPERATION: &str = "run";
const MAX_COMPONENT_BYTES: usize = 32 * 1024 * 1024;
const MAX_POOL_MEMORY_BYTES: usize = 4 * 1024 * 1024 * 1024;
const TABLE_ELEMENT_LIMIT: usize = 10_000;
const EPOCH_TICK: Duration = Duration::from_millis(10);

const INPUT_IMPORT: &str = "openopc:module/input";
const OUTPUT_IMPORT: &str = "openopc:module/output";
const ALLOWED_IMPORTS: [&str; 7] = [
    INPUT_IMPORT,
    OUTPUT_IMPORT,
    "openopc:module/http",
    "openopc:module/secret-use",
    "openopc:module/model",
    "openopc:module/usage",
    "openopc:module/log",
];

mod bindings {
    wasmtime::component::bindgen!({
        path: "wit/openopc-module.wit",
        world: "module",
        imports: { default: async | trappable },
    });
}

#[derive(Clone, Default)]
pub struct CancellationToken {
    state: Arc<CancellationState>,
}

#[derive(Default)]
struct CancellationState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.state.cancelled.store(true, Ordering::Release);
        self.state.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.state.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone)]
pub struct WasiInvocation {
    component_path: String,
    component_bytes: Arc<[u8]>,
    input: Arc<[u8]>,
    cancellation: CancellationToken,
}

impl WasiInvocation {
    pub fn new(
        component_path: String,
        component_bytes: Vec<u8>,
        input: Vec<u8>,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            component_path,
            component_bytes: component_bytes.into(),
            input: input.into(),
            cancellation,
        }
    }
}

#[derive(Clone, Debug)]
pub struct WasiExecutorConfig {
    pub max_concurrency: u16,
    pub fuel_per_cpu_millis: u64,
}

impl Default for WasiExecutorConfig {
    fn default() -> Self {
        Self {
            max_concurrency: 16,
            fuel_per_cpu_millis: 10_000,
        }
    }
}

#[derive(Debug, Error)]
pub enum WasiExecutorError {
    #[error("WASI_ENGINE_CONFIGURATION_INVALID")]
    Configuration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WasiExecutionOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasiUsage {
    pub fuel_consumed: u64,
    pub wall_time_ms: u64,
    pub output_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalEvidence {
    pub code: String,
    pub outcome: WasiExecutionOutcome,
    pub output: Vec<u8>,
    pub output_digest: String,
    pub evidence_digest: String,
    pub events: Vec<WasiEvidenceEvent>,
    pub usage: WasiUsage,
}

impl TerminalEvidence {
    pub fn from_code(code: &str) -> Self {
        terminal(code, Vec::new(), 0, Instant::now())
    }

    pub fn evidence(&self) -> serde_json::Value {
        json!({
            "code": self.code,
            "events": self.events,
            "outcome": self.outcome,
            "outputDigest": self.output_digest,
            "usage": self.usage,
            "wasmtimeVersion": WASMTIME_VERSION,
        })
    }
}

pub struct WasiExecutor {
    engine: Engine,
    engine_identity: String,
    invocation: WasiInvocation,
    bridge: Arc<dyn CapabilityBridge>,
    config: WasiExecutorConfig,
}

struct HostState {
    input: Arc<[u8]>,
    output: Vec<u8>,
    output_limit: usize,
    limits: WasiStoreLimits,
    cancellation: CancellationToken,
    deadline: Instant,
    stop_reason: Arc<AtomicU8>,
    capabilities: ExecutionCapabilities,
    evidence: WasiEvidenceRecorder,
}

#[derive(Clone, Copy)]
struct EffectiveLimits {
    fuel: u64,
    memory_bytes: usize,
    output_bytes: usize,
    wall_time: Duration,
}

impl WasiExecutor {
    pub fn new(
        config: WasiExecutorConfig,
        invocation: WasiInvocation,
        bridge: Arc<dyn CapabilityBridge>,
    ) -> Result<Self, WasiExecutorError> {
        if config.max_concurrency == 0 || config.fuel_per_cpu_millis == 0 {
            return Err(WasiExecutorError::Configuration);
        }
        let mut pooling = PoolingAllocationConfig::new();
        let slots = u32::from(config.max_concurrency);
        pooling
            .total_component_instances(slots)
            .total_core_instances(slots.saturating_mul(4))
            .total_memories(slots.saturating_mul(2))
            .total_tables(slots.saturating_mul(2))
            .total_stacks(slots)
            .max_core_instances_per_component(4)
            .max_memories_per_component(2)
            .max_tables_per_component(2)
            .max_memory_size(MAX_POOL_MEMORY_BYTES)
            .table_elements(TABLE_ELEMENT_LIMIT);

        let mut engine_config = Config::new();
        engine_config
            .wasm_component_model(true)
            .consume_fuel(true)
            .epoch_interruption(true)
            .wasm_backtrace_max_frames(None)
            .allocation_strategy(InstanceAllocationStrategy::Pooling(pooling));
        let engine = Engine::new(&engine_config).map_err(|_| WasiExecutorError::Configuration)?;
        let mut hasher = DefaultHasher::new();
        engine.precompile_compatibility_hash().hash(&mut hasher);
        let engine_identity = format!("wasmtime:{WASMTIME_VERSION}:{:016x}", hasher.finish());
        Ok(Self {
            engine,
            engine_identity,
            invocation,
            bridge,
            config,
        })
    }

    pub fn engine_identity(&self) -> &str {
        &self.engine_identity
    }

    pub async fn execute(
        &self,
        claim: &VerifiedClaim,
        descriptor: &RuntimeDescriptorV1,
    ) -> TerminalEvidence {
        let started_at = Instant::now();
        let Some((component_path, world, operation, imports, runtime_limits)) =
            wasi_descriptor(descriptor)
        else {
            return terminal("WASI_PROFILE_DENIED", Vec::new(), 0, started_at);
        };
        if component_path != self.invocation.component_path
            || world != WORLD
            || operation != OPERATION
            || claim.envelope.runtime_kind != crate::protocol::RuntimeKind::WasiComponent
        {
            return terminal("WASI_PROFILE_DENIED", Vec::new(), 0, started_at);
        }
        let Some(limits) = effective_limits(claim, runtime_limits, &self.config) else {
            return terminal("WASI_LIMIT_INVALID", Vec::new(), 0, started_at);
        };
        if self.invocation.cancellation.is_cancelled() {
            return terminal("EXECUTION_CANCELLED", Vec::new(), 0, started_at);
        }
        if self.invocation.component_bytes.len() > MAX_COMPONENT_BYTES
            || !self.invocation.component_bytes.starts_with(b"\0asm")
        {
            return terminal("WASI_COMPONENT_INVALID", Vec::new(), 0, started_at);
        }
        let component = match Component::new(&self.engine, &self.invocation.component_bytes) {
            Ok(component) => component,
            Err(_) => return terminal("WASI_COMPONENT_INVALID", Vec::new(), 0, started_at),
        };
        let declared_imports: HashSet<_> = imports.iter().map(String::as_str).collect();
        if !component_imports_allowed(&self.engine, &component, &declared_imports) {
            return terminal("WASI_IMPORT_DENIED", Vec::new(), 0, started_at);
        }
        let linker = match linker(&self.engine, &declared_imports) {
            Ok(linker) => linker,
            Err(_) => return terminal("WASI_IMPORT_DENIED", Vec::new(), 0, started_at),
        };
        let instance_pre = match linker.instantiate_pre(&component) {
            Ok(instance_pre) => instance_pre,
            Err(_) => return terminal("WASI_IMPORT_DENIED", Vec::new(), 0, started_at),
        };
        let stop_reason = Arc::new(AtomicU8::new(0));
        let mut store = Store::new(
            &self.engine,
            HostState {
                input: self.invocation.input.clone(),
                output: Vec::new(),
                output_limit: limits.output_bytes,
                limits: WasiStoreLimits::new(limits.memory_bytes, TABLE_ELEMENT_LIMIT),
                cancellation: self.invocation.cancellation.clone(),
                deadline: started_at + limits.wall_time,
                stop_reason: stop_reason.clone(),
                capabilities: ExecutionCapabilities::new(
                    claim.capability_tokens.clone(),
                    self.bridge.clone(),
                ),
                evidence: WasiEvidenceRecorder::default(),
            },
        );
        store.limiter(|state| &mut state.limits);
        if store.set_fuel(limits.fuel).is_err() {
            return terminal("WASI_LIMIT_INVALID", Vec::new(), 0, started_at);
        }
        store.set_epoch_deadline(1);
        store.epoch_deadline_callback(|store| {
            if store.data().cancellation.is_cancelled() {
                store.data().stop_reason.store(1, Ordering::Release);
                return Ok(UpdateDeadline::Interrupt);
            }
            if Instant::now() >= store.data().deadline {
                store.data().stop_reason.store(2, Ordering::Release);
                return Ok(UpdateDeadline::Interrupt);
            }
            Ok(UpdateDeadline::Continue(1))
        });

        let engine = self.engine.clone();
        let ticker_stop = Arc::new(AtomicBool::new(false));
        let ticker_stop_for_thread = ticker_stop.clone();
        let ticker = thread::spawn(move || {
            while !ticker_stop_for_thread.load(Ordering::Acquire) {
                thread::park_timeout(EPOCH_TICK);
                engine.increment_epoch();
            }
        });
        let result = async {
            let instance = instance_pre.instantiate_async(&mut store).await?;
            let run = instance.get_typed_func::<(), (u32,)>(&mut store, OPERATION)?;
            run.call_async(&mut store, ()).await
        }
        .await;
        ticker_stop.store(true, Ordering::Release);
        ticker.thread().unpark();
        let _ = ticker.join();

        let remaining_fuel = store.get_fuel().unwrap_or(0);
        let fuel_consumed = limits.fuel.saturating_sub(remaining_fuel);
        let output = std::mem::take(&mut store.data_mut().output);
        let events = std::mem::take(&mut store.data_mut().evidence).into_events();
        match result {
            Ok((0,)) => terminal_with_events("OK", output, fuel_consumed, started_at, events),
            Ok(_) => terminal_with_events(
                "WASI_GUEST_FAILED",
                output,
                fuel_consumed,
                started_at,
                events,
            ),
            Err(error) => terminal_with_events(
                execution_error_code(&error, stop_reason.load(Ordering::Acquire)),
                output,
                fuel_consumed,
                started_at,
                events,
            ),
        }
    }
}

fn wasi_descriptor(
    descriptor: &RuntimeDescriptorV1,
) -> Option<(&str, &str, &str, &[String], &crate::protocol::RuntimeLimits)> {
    match &descriptor.runtime {
        Runtime::WasiComponent {
            component,
            world,
            operation,
            imports,
            limits,
        } if descriptor.descriptor_version == 1 => {
            Some((component, world, operation, imports, limits))
        }
        _ => None,
    }
}

fn effective_limits(
    claim: &VerifiedClaim,
    runtime: &crate::protocol::RuntimeLimits,
    config: &WasiExecutorConfig,
) -> Option<EffectiveLimits> {
    let cpu_fuel = claim
        .envelope
        .resource_ceilings
        .cpu_millis
        .checked_mul(config.fuel_per_cpu_millis)?;
    let memory_mi_b = runtime
        .memory_mi_b
        .min(claim.envelope.resource_ceilings.memory_mi_b);
    Some(EffectiveLimits {
        fuel: runtime.fuel.min(cpu_fuel),
        memory_bytes: usize::try_from(memory_mi_b.checked_mul(1024 * 1024)?).ok()?,
        output_bytes: usize::try_from(runtime.output_bytes).ok()?,
        wall_time: Duration::from_millis(
            runtime
                .wall_time_ms
                .min(claim.envelope.resource_ceilings.wall_time_ms),
        ),
    })
}

fn component_imports_allowed(
    engine: &Engine,
    component: &Component,
    declared: &HashSet<&str>,
) -> bool {
    component.component_type().imports(engine).all(|(name, _)| {
        let Some((base, version)) = name.rsplit_once('@') else {
            return false;
        };
        version == "1.0.0" && ALLOWED_IMPORTS.contains(&base) && declared.contains(base)
    })
}

fn linker(engine: &Engine, declared: &HashSet<&str>) -> wasmtime::Result<Linker<HostState>> {
    let mut linker = Linker::new(engine);
    if declared.contains(INPUT_IMPORT) {
        bindings::openopc::module::input::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| {
            state
        })?;
    }
    if declared.contains(OUTPUT_IMPORT) {
        bindings::openopc::module::output::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| {
            state
        })?;
    }
    if declared.contains("openopc:module/http") {
        bindings::openopc::module::http::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| {
            state
        })?;
    }
    if declared.contains("openopc:module/secret-use") {
        bindings::openopc::module::secret_use::add_to_linker::<_, HasSelf<_>>(
            &mut linker,
            |state| state,
        )?;
    }
    if declared.contains("openopc:module/model") {
        bindings::openopc::module::model::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| {
            state
        })?;
    }
    if declared.contains("openopc:module/usage") {
        bindings::openopc::module::usage::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| {
            state
        })?;
    }
    if declared.contains("openopc:module/log") {
        bindings::openopc::module::log::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)?;
    }
    Ok(linker)
}

impl bindings::openopc::module::input::Host for HostState {
    async fn len(&mut self) -> wasmtime::Result<u64> {
        Ok(self.input.len() as u64)
    }

    async fn read_byte(&mut self, offset: u64) -> wasmtime::Result<u32> {
        Ok(usize::try_from(offset)
            .ok()
            .and_then(|offset| self.input.get(offset).copied())
            .map(u32::from)
            .unwrap_or(256))
    }
}

impl bindings::openopc::module::output::Host for HostState {
    async fn write_byte(&mut self, value: u8) -> wasmtime::Result<u32> {
        if self.output.len() >= self.output_limit {
            return Err(wasmtime::Error::new(WasiLimitError::Output));
        }
        self.output.push(value);
        Ok(0)
    }
}

impl bindings::openopc::module::http::Host for HostState {
    async fn request(
        &mut self,
        capability: u32,
        method: String,
        url: String,
        body: Vec<u8>,
    ) -> wasmtime::Result<Result<bindings::openopc::module::http::HttpResponse, u32>> {
        let request_digest = event_digest(json!({
            "bodyDigest": sha256_digest(&body),
            "capabilityIndex": capability,
            "method": method,
            "urlDigest": sha256_digest(url.as_bytes()),
        }));
        let result = self.capabilities.http(capability, method, url, body).await;
        Ok(match result {
            Ok(response) => {
                self.evidence.record_capability(
                    "http",
                    request_digest,
                    0,
                    Some(sha256_digest(&response.body)),
                );
                Ok(bindings::openopc::module::http::HttpResponse {
                    status: response.status,
                    body: response.body,
                })
            }
            Err(error) => {
                let code = capability_error_code(&error);
                self.evidence
                    .record_capability("http", request_digest, code, None);
                Err(code)
            }
        })
    }
}

impl bindings::openopc::module::secret_use::Host for HostState {
    async fn invoke(
        &mut self,
        capability: u32,
        action: String,
        payload: Vec<u8>,
    ) -> wasmtime::Result<Result<Vec<u8>, u32>> {
        let request_digest = event_digest(json!({
            "action": action,
            "capabilityIndex": capability,
            "payloadDigest": sha256_digest(&payload),
        }));
        let result = self
            .capabilities
            .secret_use(capability, action, payload)
            .await;
        Ok(match result {
            Ok(response) => {
                self.evidence.record_capability(
                    "secret-use",
                    request_digest,
                    0,
                    Some(sha256_digest(&response.body)),
                );
                Ok(response.body)
            }
            Err(error) => {
                let code = capability_error_code(&error);
                self.evidence
                    .record_capability("secret-use", request_digest, code, None);
                Err(code)
            }
        })
    }
}

impl bindings::openopc::module::model::Host for HostState {
    async fn invoke(
        &mut self,
        capability: u32,
        operation: String,
        payload: Vec<u8>,
    ) -> wasmtime::Result<Result<Vec<u8>, u32>> {
        let request_digest = event_digest(json!({
            "capabilityIndex": capability,
            "operation": operation,
            "payloadDigest": sha256_digest(&payload),
        }));
        let result = self
            .capabilities
            .model(capability, operation, payload)
            .await;
        Ok(match result {
            Ok(response) => {
                self.evidence.record_capability(
                    "model",
                    request_digest,
                    0,
                    Some(sha256_digest(&response.body)),
                );
                Ok(response.body)
            }
            Err(error) => {
                let code = capability_error_code(&error);
                self.evidence
                    .record_capability("model", request_digest, code, None);
                Err(code)
            }
        })
    }
}

impl bindings::openopc::module::usage::Host for HostState {
    async fn record_usage(&mut self, kind: String, units: u64) -> wasmtime::Result<u32> {
        Ok(self.evidence.record_usage(&kind, units))
    }
}

impl bindings::openopc::module::log::Host for HostState {
    async fn emit(
        &mut self,
        level: bindings::openopc::module::log::LogLevel,
        message: String,
    ) -> wasmtime::Result<u32> {
        let level = match level {
            bindings::openopc::module::log::LogLevel::Debug => "debug",
            bindings::openopc::module::log::LogLevel::Info => "info",
            bindings::openopc::module::log::LogLevel::Warn => "warn",
            bindings::openopc::module::log::LogLevel::Error => "error",
        };
        Ok(self.evidence.record_log(level, &message))
    }
}

fn capability_error_code(error: &CapabilityBridgeError) -> u32 {
    match error {
        CapabilityBridgeError::Denied => 1,
        CapabilityBridgeError::Unavailable => 2,
        CapabilityBridgeError::Limit => 3,
    }
}

fn event_digest(value: serde_json::Value) -> String {
    evidence_digest(&value)
        .unwrap_or_else(|_| format!("sha256:{:x}", Sha256::digest(b"invalid-event")))
}

fn sha256_digest(value: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(value))
}

fn execution_error_code(error: &wasmtime::Error, stop_reason: u8) -> &'static str {
    match stop_reason {
        1 => return "EXECUTION_CANCELLED",
        2 => return "WASI_WALL_TIME_EXCEEDED",
        _ => {}
    }
    if matches!(error.downcast_ref::<Trap>(), Some(Trap::OutOfFuel)) {
        return "WASI_FUEL_EXHAUSTED";
    }
    match error.downcast_ref::<WasiLimitError>() {
        Some(WasiLimitError::Memory) => "WASI_MEMORY_LIMIT",
        Some(WasiLimitError::Table) => "WASI_TABLE_LIMIT",
        Some(WasiLimitError::Output) => "WASI_OUTPUT_LIMIT",
        None if matches!(error.downcast_ref::<Trap>(), Some(Trap::Interrupt)) => {
            "WASI_WALL_TIME_EXCEEDED"
        }
        None => "WASI_TRAP",
    }
}

fn terminal(
    code: &str,
    output: Vec<u8>,
    fuel_consumed: u64,
    started_at: Instant,
) -> TerminalEvidence {
    terminal_with_events(code, output, fuel_consumed, started_at, Vec::new())
}

fn terminal_with_events(
    code: &str,
    output: Vec<u8>,
    fuel_consumed: u64,
    started_at: Instant,
    events: Vec<WasiEvidenceEvent>,
) -> TerminalEvidence {
    let outcome = match code {
        "OK" => WasiExecutionOutcome::Succeeded,
        "EXECUTION_CANCELLED" => WasiExecutionOutcome::Cancelled,
        _ => WasiExecutionOutcome::Failed,
    };
    let output_digest = format!("sha256:{:x}", Sha256::digest(&output));
    let usage = WasiUsage {
        fuel_consumed,
        wall_time_ms: u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
        output_bytes: u64::try_from(output.len()).unwrap_or(u64::MAX),
    };
    let evidence = json!({
        "code": code,
        "events": events,
        "outcome": outcome,
        "outputDigest": output_digest,
        "usage": usage,
        "wasmtimeVersion": WASMTIME_VERSION,
    });
    let evidence_digest = evidence_digest(&evidence)
        .unwrap_or_else(|_| format!("sha256:{:x}", Sha256::digest(code.as_bytes())));
    TerminalEvidence {
        code: code.to_owned(),
        outcome,
        output,
        output_digest,
        evidence_digest,
        events,
        usage,
    }
}
