use std::sync::{Arc, Mutex};

use openopc_module_runner::protocol::{CapabilityAudience, RunnerCapabilityTokenV1};
use openopc_module_runner::wasi::{
    CapabilityBridge, CapabilityBridgeError, CapabilityFuture, CapabilityRequest,
    CapabilityResponse, EgressCapabilityBridge, EgressTransport, EgressTransportFuture,
    EgressTransportRequest, EgressTransportResponse, ExecutionCapabilities,
};

#[derive(Default)]
struct RecordingBridge {
    requests: Mutex<Vec<CapabilityRequest>>,
}

impl CapabilityBridge for RecordingBridge {
    fn invoke<'a>(&'a self, request: CapabilityRequest) -> CapabilityFuture<'a> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request);
            Ok(CapabilityResponse {
                status: 201,
                body: b"mediated".to_vec(),
            })
        })
    }
}

#[derive(Default)]
struct RecordingEgressTransport {
    requests: Mutex<Vec<EgressTransportRequest>>,
}

impl EgressTransport for RecordingEgressTransport {
    fn send<'a>(&'a self, request: EgressTransportRequest) -> EgressTransportFuture<'a> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request);
            Ok(EgressTransportResponse {
                status: 201,
                body: b"proxied".to_vec(),
            })
        })
    }
}

fn token(grant_id: &str, audience: CapabilityAudience, token: &str) -> RunnerCapabilityTokenV1 {
    RunnerCapabilityTokenV1 {
        grant_id: grant_id.into(),
        audience,
        token: token.into(),
    }
}

#[tokio::test]
async fn resolves_capability_indices_by_audience_before_invoking_the_bridge() {
    let bridge = Arc::new(RecordingBridge::default());
    let capabilities = ExecutionCapabilities::new(
        vec![
            token("egress", CapabilityAudience::Egress, "egress-token"),
            token("secret", CapabilityAudience::Secret, "secret-token"),
            token("model", CapabilityAudience::Model, "model-token"),
        ],
        bridge.clone(),
    );

    let response = capabilities
        .http(
            0,
            "POST".into(),
            "https://example.com/v1".into(),
            b"body".to_vec(),
        )
        .await
        .unwrap();
    assert_eq!(response.status, 201);
    assert_eq!(response.body, b"mediated");

    let denied = capabilities
        .http(1, "GET".into(), "https://example.com".into(), Vec::new())
        .await;
    assert!(matches!(denied, Err(CapabilityBridgeError::Denied)));

    capabilities
        .secret_use(1, "sign".into(), b"payload".to_vec())
        .await
        .unwrap();
    capabilities
        .model(2, "responses.create".into(), b"payload".to_vec())
        .await
        .unwrap();

    let requests = bridge.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    match &requests[0] {
        CapabilityRequest::Http {
            capability_index,
            credential,
            method,
            url,
            body,
        } => {
            assert_eq!(*capability_index, 0);
            assert_eq!(credential.expose(), "egress-token");
            assert_eq!(method, "POST");
            assert_eq!(url, "https://example.com/v1");
            assert_eq!(body, b"body");
        }
        request => panic!("unexpected request: {request:?}"),
    }
    assert!(format!("{:?}", requests[0]).contains("<redacted>"));
    assert!(!format!("{:?}", requests[0]).contains("egress-token"));
}

#[tokio::test]
async fn forwards_http_only_through_the_task9_egress_contract() {
    let transport = Arc::new(RecordingEgressTransport::default());

    let bridge = Arc::new(
        EgressCapabilityBridge::with_transport(
            "https://egress.openopc.internal".parse().unwrap(),
            "p".repeat(32),
            "b".repeat(64),
            transport.clone(),
        )
        .unwrap(),
    );
    let capabilities = ExecutionCapabilities::new(
        vec![token("egress", CapabilityAudience::Egress, "egress-token")],
        bridge,
    );
    let response = capabilities
        .http(
            0,
            "POST".into(),
            "https://api.example.com/v1/messages".into(),
            b"request-body".to_vec(),
        )
        .await
        .unwrap();

    assert_eq!(response.status, 201);
    assert_eq!(response.body, b"proxied");
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.method.as_str(), "POST");
    assert_eq!(
        request.url.as_str(),
        "https://egress.openopc.internal/v1/egress?url=https%3A%2F%2Fapi.example.com%2Fv1%2Fmessages"
    );
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer egress-token"
    );
    assert_eq!(
        request
            .headers
            .get("x-openopc-egress-proxy-secret")
            .unwrap(),
        &"p".repeat(32)
    );
    assert_eq!(
        request.headers.get("x-openopc-client-cert-sha256").unwrap(),
        &"b".repeat(64)
    );
    assert_eq!(
        request.headers.get("x-openopc-mtls-verified").unwrap(),
        "SUCCESS"
    );
    assert_eq!(request.body, b"request-body");
}
