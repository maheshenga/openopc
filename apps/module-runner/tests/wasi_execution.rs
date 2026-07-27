use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use openopc_module_runner::protocol::{
    RunnerCapabilityTokenV1, Runtime, RuntimeDescriptorV1, RuntimeKind, RuntimeLimits,
    VerifiedClaim, WorkEnvelopeGrantV1, WorkEnvelopeLeaseV1, WorkEnvelopeResourceCeilingsV1,
    WorkEnvelopeV1,
};
use openopc_module_runner::wasi::{
    CancellationToken, DenyCapabilityBridge, TerminalEvidence, WasiExecutor, WasiExecutorConfig,
    WasiInvocation,
};
use sha2::{Digest, Sha256};

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn claim() -> VerifiedClaim {
    VerifiedClaim {
        envelope: WorkEnvelopeV1 {
            envelope_version: 1,
            execution_id: "10000000-0000-4000-8000-000000000001".into(),
            account_id: "10000000-0000-4000-8000-000000000002".into(),
            project_id: "10000000-0000-4000-8000-000000000003".into(),
            installation_id: "10000000-0000-4000-8000-000000000004".into(),
            idempotency_key: "module-execution-op-1".into(),
            install_revision: 3,
            release_id: "10000000-0000-4000-8000-000000000007".into(),
            release_digest: digest('1'),
            consent_revision_id: "10000000-0000-4000-8000-000000000008".into(),
            permission_digest: digest('4'),
            runtime_descriptor_id: "10000000-0000-4000-8000-000000000009".into(),
            runtime_descriptor_digest: digest('2'),
            runtime_kind: RuntimeKind::WasiComponent,
            runtime_profile: "wasmtime-component-v1".into(),
            policy_digest: digest('3'),
            kill_switch_generation: 7,
            execution_deadline: "2099-07-30T10:30:00.000Z".into(),
            binding_digest: digest('5'),
            resource_ceilings: WorkEnvelopeResourceCeilingsV1 {
                cpu_millis: 60_000,
                memory_mi_b: 64,
                wall_time_ms: 1_000,
                cost_micro: 50_000,
            },
            lease: WorkEnvelopeLeaseV1 {
                id: "10000000-0000-4000-8000-000000000005".into(),
                generation: 1,
                deadline: "2099-07-30T10:00:00.000Z".into(),
            },
            grants: Vec::<WorkEnvelopeGrantV1>::new(),
        },
        capability_tokens: Vec::<RunnerCapabilityTokenV1>::new(),
    }
}

fn descriptor(
    component: &str,
    fuel: u64,
    memory_mi_b: u64,
    wall_time_ms: u64,
    output_bytes: u64,
) -> RuntimeDescriptorV1 {
    RuntimeDescriptorV1 {
        descriptor_version: 1,
        runtime: Runtime::WasiComponent {
            component: component.into(),
            world: "openopc:module/module@1.0.0".into(),
            operation: "run".into(),
            imports: vec![
                "openopc:module/input".into(),
                "openopc:module/output".into(),
            ],
            limits: RuntimeLimits {
                cpu_millis: 60_000,
                fuel,
                memory_mi_b,
                output_bytes,
                pids: 1,
                wall_time_ms,
            },
        },
    }
}

fn fixture(name: &str) -> Vec<u8> {
    fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/components")
            .join(name),
    )
    .unwrap()
}

async fn run(
    name: &str,
    input: &[u8],
    fuel: u64,
    memory_mi_b: u64,
    wall_time_ms: u64,
    output_bytes: u64,
    cancellation: CancellationToken,
) -> TerminalEvidence {
    run_with_config(
        name,
        input,
        fuel,
        memory_mi_b,
        wall_time_ms,
        output_bytes,
        cancellation,
        WasiExecutorConfig::default(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_with_config(
    name: &str,
    input: &[u8],
    fuel: u64,
    memory_mi_b: u64,
    wall_time_ms: u64,
    output_bytes: u64,
    cancellation: CancellationToken,
    config: WasiExecutorConfig,
) -> TerminalEvidence {
    let invocation = WasiInvocation::new(
        format!("components/{name}"),
        fixture(name),
        input.to_vec(),
        cancellation,
    );
    let executor = WasiExecutor::new(config, invocation, Arc::new(DenyCapabilityBridge)).unwrap();
    executor
        .execute(
            &claim(),
            &descriptor(
                &format!("components/{name}"),
                fuel,
                memory_mi_b,
                wall_time_ms,
                output_bytes,
            ),
        )
        .await
}

#[tokio::test]
async fn echoes_immutable_input_through_the_bounded_output_sink() {
    let input = b"echo from immutable input";
    let evidence = run(
        "echo.component.wasm",
        input,
        10_000_000,
        64,
        1_000,
        4_096,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(evidence.code, "OK");
    assert_eq!(evidence.output, input);
    assert_eq!(
        evidence.output_digest,
        format!("sha256:{:x}", Sha256::digest(input))
    );
    assert!(evidence.evidence_digest.starts_with("sha256:"));
    assert_eq!(evidence.evidence_digest.len(), 71);
}

#[tokio::test]
async fn rejects_ambient_wasi_and_undeclared_openopc_imports() {
    for name in [
        "undeclared-import.component.wasm",
        "raw-socket.component.wasm",
        "filesystem-escape.component.wasm",
    ] {
        assert_eq!(
            run(
                name,
                b"",
                10_000,
                64,
                1_000,
                4_096,
                CancellationToken::new(),
            )
            .await
            .code,
            "WASI_IMPORT_DENIED",
            "{name} must not receive ambient WASI access"
        )
    }
}

#[tokio::test]
async fn typechecks_the_complete_openopc_world_without_ambient_wasi() {
    let name = "all-imports.component.wasm";
    let invocation = WasiInvocation::new(
        format!("components/{name}"),
        fixture(name),
        Vec::new(),
        CancellationToken::new(),
    );
    let executor = WasiExecutor::new(
        WasiExecutorConfig::default(),
        invocation,
        Arc::new(DenyCapabilityBridge),
    )
    .unwrap();
    let mut descriptor = descriptor(&format!("components/{name}"), 10_000_000, 64, 1_000, 4_096);
    let Runtime::WasiComponent { imports, .. } = &mut descriptor.runtime else {
        unreachable!();
    };
    *imports = [
        "openopc:module/input",
        "openopc:module/output",
        "openopc:module/http",
        "openopc:module/secret-use",
        "openopc:module/model",
        "openopc:module/usage",
        "openopc:module/log",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();

    let evidence = executor.execute(&claim(), &descriptor).await;
    assert_eq!(evidence.code, "WASI_TRAP");
}

#[tokio::test]
async fn maps_fuel_memory_and_output_breaches_to_stable_codes() {
    assert_eq!(
        run(
            "spin.component.wasm",
            b"",
            100,
            64,
            1_000,
            4_096,
            CancellationToken::new(),
        )
        .await
        .code,
        "WASI_FUEL_EXHAUSTED"
    );
    assert_eq!(
        run(
            "memory-limit.component.wasm",
            b"",
            10_000_000,
            1,
            1_000,
            4_096,
            CancellationToken::new(),
        )
        .await
        .code,
        "WASI_MEMORY_LIMIT"
    );
    let output = run(
        "output-limit.component.wasm",
        b"",
        10_000_000,
        64,
        1_000,
        1,
        CancellationToken::new(),
    )
    .await;
    assert_eq!(output.code, "WASI_OUTPUT_LIMIT");
    assert_eq!(output.output, b"A");
}

#[tokio::test]
async fn interrupts_a_component_at_its_wall_clock_deadline() {
    let evidence = tokio::time::timeout(
        Duration::from_secs(2),
        run_with_config(
            "spin.component.wasm",
            b"",
            1_000_000_000_000,
            64,
            20,
            4_096,
            CancellationToken::new(),
            WasiExecutorConfig {
                fuel_per_cpu_millis: 1_000_000_000,
                ..WasiExecutorConfig::default()
            },
        ),
    )
    .await
    .expect("epoch interruption must stop the component");
    assert_eq!(evidence.code, "WASI_WALL_TIME_EXCEEDED");
}

#[tokio::test]
async fn interrupts_a_component_when_the_execution_is_cancelled() {
    let cancellation = CancellationToken::new();
    let cancel = cancellation.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        cancel.cancel();
    });
    let evidence = tokio::time::timeout(
        Duration::from_secs(2),
        run_with_config(
            "spin.component.wasm",
            b"",
            1_000_000_000_000,
            64,
            1_000,
            4_096,
            cancellation,
            WasiExecutorConfig {
                fuel_per_cpu_millis: 1_000_000_000,
                ..WasiExecutorConfig::default()
            },
        ),
    )
    .await
    .expect("epoch interruption must observe cancellation");
    canceller.join().unwrap();
    assert_eq!(evidence.code, "EXECUTION_CANCELLED");
}
