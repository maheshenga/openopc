use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{TimeZone, Utc};
use ed25519_dalek::{Signer, SigningKey};
use openopc_module_runner::protocol::{self, ProtocolError, Runtime};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const INPUT_DIGEST: &str =
    "sha256:e844558922d2b0432d7ccf86f3f56b1afadfbaa9a0add07371f46f1a868821ef";
const DESCRIPTOR_DIGEST: &str =
    "sha256:42aa9d47b5b374e80fa2077d76a9488331dd93478fa808a30f3b28c9f3d54aa7";
const ARTIFACT_DIGEST: &str =
    "sha256:8888888888888888888888888888888888888888888888888888888888888888";
const BINDING_DIGEST: &str =
    "sha256:082e861f22906420472fdace2dd4a614c9a0593ad8eb7cb518194c21d7afcff4";

fn descriptor() -> Value {
    json!({
        "descriptorVersion": 1,
        "runtime": {
            "kind": "wasi-component",
            "component": "runtime/main.wasm",
            "world": "openopc:module/runtime",
            "operation": "run",
            "imports": ["openopc:module/input", "openopc:module/output"],
            "limits": {
                "cpuMillis": 10_000,
                "fuel": 10_000_000,
                "memoryMiB": 512,
                "outputBytes": 1_048_576,
                "pids": 16,
                "wallTimeMs": 120_000
            }
        }
    })
}

fn envelope() -> Value {
    json!({
        "envelopeVersion": 1,
        "executionId": "10000000-0000-4000-8000-000000000001",
        "accountId": "20000000-0000-4000-8000-000000000001",
        "projectId": "30000000-0000-4000-8000-000000000001",
        "installationId": "40000000-0000-4000-8000-000000000001",
        "idempotencyKey": "execution-op-1",
        "installRevision": 1,
        "releaseId": "50000000-0000-4000-8000-000000000001",
        "releaseDigest": format!("sha256:{}", "2".repeat(64)),
        "consentRevisionId": "60000000-0000-4000-8000-000000000001",
        "permissionDigest": format!("sha256:{}", "3".repeat(64)),
        "runtimeDescriptorId": "70000000-0000-4000-8000-000000000001",
        "runtimeDescriptorDigest": DESCRIPTOR_DIGEST,
        "inputDigest": INPUT_DIGEST,
        "runtimeArtifactDigest": ARTIFACT_DIGEST,
        "runtimeArtifactBytes": 4096,
        "runtimeKind": "wasi-component",
        "runtimeProfile": "openopc-wasi-v1",
        "policyDigest": format!("sha256:{}", "4".repeat(64)),
        "killSwitchGeneration": 0,
        "executionDeadline": "2026-07-27T09:00:00.000Z",
        "bindingDigest": BINDING_DIGEST,
        "resourceCeilings": {
            "cpuMillis": 10_000,
            "memoryMiB": 512,
            "wallTimeMs": 120_000,
            "costMicro": 0
        },
        "lease": {
            "id": "80000000-0000-4000-8000-000000000001",
            "generation": 1,
            "deadline": "2026-07-27T08:00:30.000Z"
        },
        "grants": []
    })
}

fn sign(envelope: &Value, key: &SigningKey) -> String {
    let protected = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "alg": "EdDSA",
            "typ": "openopc-work-envelope+jwt",
            "kid": "staging-execution-v1",
            "traceparent": "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
        }))
        .unwrap(),
    );
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(envelope).unwrap());
    let signing_input = format!("{protected}.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(key.sign(signing_input.as_bytes()).to_bytes());
    format!("{signing_input}.{signature}")
}

fn bundle(key: &SigningKey) -> protocol::RunnerClaimBundleV1 {
    serde_json::from_value(json!({
        "signedEnvelope": sign(&envelope(), key),
        "capabilityTokens": [],
        "runtimeDescriptor": descriptor(),
        "inputBase64": URL_SAFE_NO_PAD.encode(br#"{"prompt":"claim"}"#),
        "runtimeArtifact": {
            "fetchPath": "module-runtime/artifacts/fetch",
            "digest": ARTIFACT_DIGEST,
            "bytes": 4096
        }
    }))
    .unwrap()
}

fn bundle_with_input(key: &SigningKey, input: &[u8]) -> protocol::RunnerClaimBundleV1 {
    let mut bound_envelope = envelope();
    bound_envelope["inputDigest"] = json!(format!("sha256:{:x}", Sha256::digest(input)));
    let parsed = protocol::parse_work_envelope_value(bound_envelope.clone()).unwrap();
    bound_envelope["bindingDigest"] = json!(protocol::compute_binding_digest(&parsed).unwrap());
    let mut claim_bundle = bundle(key);
    claim_bundle.signed_envelope = sign(&bound_envelope, key);
    claim_bundle.input_base64 = URL_SAFE_NO_PAD.encode(input);
    claim_bundle
}

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 7, 27, 8, 0, 0).unwrap()
}

#[test]
fn verifies_the_complete_signed_execution_bundle() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let verified = protocol::verify_claim_bundle(
        bundle(&key),
        &key.verifying_key(),
        "staging-execution-v1",
        now(),
    )
    .unwrap();

    assert_eq!(verified.claim.envelope.input_digest, INPUT_DIGEST);
    assert_eq!(
        verified.runtime_descriptor,
        serde_json::from_value(descriptor()).unwrap()
    );
    assert_eq!(verified.input, br#"{"prompt":"claim"}"#);
    assert_eq!(verified.runtime_artifact.digest, ARTIFACT_DIGEST);
    assert_eq!(verified.runtime_artifact.bytes, 4096);
}

#[test]
fn reproduces_the_typescript_binding_vector_and_binds_each_new_field() {
    let parsed = protocol::parse_work_envelope_value(envelope()).unwrap();
    assert_eq!(
        protocol::compute_binding_digest(&parsed).unwrap(),
        BINDING_DIGEST
    );

    let mut changed = parsed.clone();
    changed.input_digest = format!("sha256:{}", "9".repeat(64));
    assert_ne!(
        protocol::compute_binding_digest(&changed).unwrap(),
        BINDING_DIGEST
    );

    let mut changed = parsed.clone();
    changed.runtime_artifact_digest = format!("sha256:{}", "9".repeat(64));
    assert_ne!(
        protocol::compute_binding_digest(&changed).unwrap(),
        BINDING_DIGEST
    );

    let mut changed = parsed;
    changed.runtime_artifact_bytes += 1;
    assert_ne!(
        protocol::compute_binding_digest(&changed).unwrap(),
        BINDING_DIGEST
    );
}

#[test]
fn rejects_descriptor_input_and_artifact_substitution_with_stable_errors() {
    let key = SigningKey::from_bytes(&[7; 32]);

    let mut changed_descriptor = bundle(&key);
    let Runtime::WasiComponent { operation, .. } =
        &mut changed_descriptor.runtime_descriptor.runtime
    else {
        panic!("expected WASI descriptor");
    };
    *operation = "substituted".into();
    assert!(matches!(
        protocol::verify_claim_bundle(
            changed_descriptor,
            &key.verifying_key(),
            "staging-execution-v1",
            now(),
        ),
        Err(ProtocolError::DescriptorDigestMismatch)
    ));

    let mut non_canonical_input = bundle(&key);
    non_canonical_input.input_base64 = URL_SAFE_NO_PAD.encode(br#"{ "prompt": "claim" }"#);
    assert!(matches!(
        protocol::verify_claim_bundle(
            non_canonical_input,
            &key.verifying_key(),
            "staging-execution-v1",
            now(),
        ),
        Err(ProtocolError::InputDigestMismatch)
    ));

    let mut changed_artifact = bundle(&key);
    changed_artifact.runtime_artifact.digest = format!("sha256:{}", "9".repeat(64));
    assert!(matches!(
        protocol::verify_claim_bundle(
            changed_artifact,
            &key.verifying_key(),
            "staging-execution-v1",
            now(),
        ),
        Err(ProtocolError::ArtifactDigestMismatch)
    ));

    let mut oversized_artifact = bundle(&key);
    oversized_artifact.runtime_artifact.bytes = 33_554_433;
    assert!(matches!(
        protocol::verify_claim_bundle(
            oversized_artifact,
            &key.verifying_key(),
            "staging-execution-v1",
            now(),
        ),
        Err(ProtocolError::ArtifactLimit)
    ));
}

#[test]
fn rejects_unknown_fields_padding_and_runtime_kind_disagreement() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let mut unknown = serde_json::to_value(bundle(&key)).unwrap();
    unknown["unexpected"] = json!(true);
    assert!(matches!(
        protocol::parse_runner_claim_bundle_value(unknown),
        Err(ProtocolError::InvalidClaimBundle)
    ));

    let mut padded = bundle(&key);
    padded.input_base64.push('=');
    assert!(
        protocol::verify_claim_bundle(padded, &key.verifying_key(), "staging-execution-v1", now(),)
            .is_err()
    );

    let mut mismatched_envelope = envelope();
    mismatched_envelope["runtimeKind"] = json!("oci-image");
    let parsed = protocol::parse_work_envelope_value(mismatched_envelope.clone()).unwrap();
    mismatched_envelope["bindingDigest"] =
        json!(protocol::compute_binding_digest(&parsed).unwrap());
    let mut mismatched = bundle(&key);
    mismatched.signed_envelope = sign(&mismatched_envelope, &key);
    assert!(matches!(
        protocol::verify_claim_bundle(
            mismatched,
            &key.verifying_key(),
            "staging-execution-v1",
            now(),
        ),
        Err(ProtocolError::DescriptorDigestMismatch)
    ));
}

#[test]
fn rejects_numeric_spellings_that_typescript_canonical_json_rewrites() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let non_canonical = br#"{"value":1.0}"#;

    assert!(matches!(
        protocol::verify_claim_bundle(
            bundle_with_input(&key, non_canonical),
            &key.verifying_key(),
            "staging-execution-v1",
            now(),
        ),
        Err(ProtocolError::InputDigestMismatch)
    ));
}

#[test]
fn accepts_typescript_utf16_key_order_for_supplementary_unicode() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let input = format!(r#"{{"{}":1,"{}":0}}"#, '\u{1f600}', '\u{e000}');

    let verified = protocol::verify_claim_bundle(
        bundle_with_input(&key, input.as_bytes()),
        &key.verifying_key(),
        "staging-execution-v1",
        now(),
    )
    .unwrap();

    assert_eq!(verified.input, input.as_bytes());
}
