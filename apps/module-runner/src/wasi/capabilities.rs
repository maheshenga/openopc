use std::fmt;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use thiserror::Error;
use url::Url;
use zeroize::Zeroize;

use crate::protocol::{CapabilityAudience, RunnerCapabilityTokenV1};

const MAX_CAPABILITY_BODY_BYTES: usize = 1024 * 1024;
const MAX_METHOD_BYTES: usize = 16;
const MAX_OPERATION_BYTES: usize = 128;
const MAX_URL_BYTES: usize = 2_048;

#[derive(Clone, PartialEq, Eq)]
pub struct CapabilityCredential(String);

impl CapabilityCredential {
    fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CapabilityCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl Drop for CapabilityCredential {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapabilityRequest {
    Http {
        capability_index: u32,
        credential: CapabilityCredential,
        method: String,
        url: String,
        body: Vec<u8>,
    },
    SecretUse {
        capability_index: u32,
        credential: CapabilityCredential,
        action: String,
        payload: Vec<u8>,
    },
    Model {
        capability_index: u32,
        credential: CapabilityCredential,
        operation: String,
        payload: Vec<u8>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum CapabilityBridgeError {
    #[error("WASI_CAPABILITY_DENIED")]
    Denied,
    #[error("WASI_CAPABILITY_UNAVAILABLE")]
    Unavailable,
    #[error("WASI_CAPABILITY_LIMIT")]
    Limit,
}

pub type CapabilityFuture<'a> =
    Pin<Box<dyn Future<Output = Result<CapabilityResponse, CapabilityBridgeError>> + Send + 'a>>;

pub trait CapabilityBridge: Send + Sync {
    fn invoke<'a>(&'a self, request: CapabilityRequest) -> CapabilityFuture<'a>;
}

#[derive(Debug, Error)]
#[error("WASI_EGRESS_CONFIGURATION_INVALID")]
pub struct EgressCapabilityBridgeError;

#[derive(Clone, Debug)]
pub struct EgressTransportRequest {
    pub method: reqwest::Method,
    pub url: Url,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EgressTransportResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub type EgressTransportFuture<'a> = Pin<
    Box<dyn Future<Output = Result<EgressTransportResponse, CapabilityBridgeError>> + Send + 'a>,
>;

pub trait EgressTransport: Send + Sync {
    fn send<'a>(&'a self, request: EgressTransportRequest) -> EgressTransportFuture<'a>;
}

#[derive(Default)]
struct ResponseBodyBuffer {
    body: Vec<u8>,
}

impl ResponseBodyBuffer {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            body: Vec::with_capacity(capacity.min(MAX_CAPABILITY_BODY_BYTES)),
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<(), CapabilityBridgeError> {
        if chunk.len() > MAX_CAPABILITY_BODY_BYTES.saturating_sub(self.body.len()) {
            return Err(CapabilityBridgeError::Limit);
        }
        self.body.extend_from_slice(chunk);
        Ok(())
    }

    fn into_body(self) -> Vec<u8> {
        self.body
    }
}

pub struct ReqwestEgressTransport {
    client: reqwest::Client,
}

impl ReqwestEgressTransport {
    pub fn new() -> Result<Self, EgressCapabilityBridgeError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| EgressCapabilityBridgeError)?;
        Ok(Self { client })
    }
}

impl EgressTransport for ReqwestEgressTransport {
    fn send<'a>(&'a self, request: EgressTransportRequest) -> EgressTransportFuture<'a> {
        Box::pin(async move {
            let mut response = self
                .client
                .request(request.method, request.url)
                .headers(request.headers)
                .body(request.body)
                .send()
                .await
                .map_err(|_| CapabilityBridgeError::Unavailable)?;
            let status = response.status().as_u16();
            let content_length = response.content_length().unwrap_or(0);
            if content_length > MAX_CAPABILITY_BODY_BYTES as u64 {
                return Err(CapabilityBridgeError::Limit);
            }
            let mut body = ResponseBodyBuffer::with_capacity(content_length as usize);
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| CapabilityBridgeError::Unavailable)?
            {
                body.push(&chunk)?;
            }
            Ok(EgressTransportResponse {
                status,
                body: body.into_body(),
            })
        })
    }
}

pub struct EgressCapabilityBridge {
    endpoint: Url,
    proxy_secret: CapabilityCredential,
    certificate_thumbprint: String,
    transport: Arc<dyn EgressTransport>,
}

impl EgressCapabilityBridge {
    pub fn new(
        endpoint: Url,
        proxy_secret: String,
        certificate_thumbprint: String,
    ) -> Result<Self, EgressCapabilityBridgeError> {
        Self::with_transport(
            endpoint,
            proxy_secret,
            certificate_thumbprint,
            Arc::new(ReqwestEgressTransport::new()?),
        )
    }

    pub fn with_transport(
        endpoint: Url,
        proxy_secret: String,
        certificate_thumbprint: String,
        transport: Arc<dyn EgressTransport>,
    ) -> Result<Self, EgressCapabilityBridgeError> {
        let loopback_http = endpoint.scheme() == "http"
            && endpoint
                .host_str()
                .and_then(|host| host.parse::<IpAddr>().ok())
                .is_some_and(|address| address.is_loopback());
        if (endpoint.scheme() != "https" && !loopback_http)
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || !matches!(endpoint.path(), "" | "/")
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || proxy_secret.len() < 32
            || proxy_secret.len() > 4_096
            || proxy_secret.chars().any(char::is_control)
            || certificate_thumbprint.len() != 64
            || !certificate_thumbprint
                .chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
        {
            return Err(EgressCapabilityBridgeError);
        }
        Ok(Self {
            endpoint,
            proxy_secret: CapabilityCredential::new(proxy_secret),
            certificate_thumbprint,
            transport,
        })
    }
}

impl CapabilityBridge for EgressCapabilityBridge {
    fn invoke<'a>(&'a self, request: CapabilityRequest) -> CapabilityFuture<'a> {
        Box::pin(async move {
            let CapabilityRequest::Http {
                credential,
                method,
                url,
                body,
                ..
            } = request
            else {
                return Err(CapabilityBridgeError::Unavailable);
            };
            let method = reqwest::Method::from_bytes(method.as_bytes())
                .map_err(|_| CapabilityBridgeError::Denied)?;
            let mut endpoint = self.endpoint.clone();
            endpoint.set_path("/v1/egress");
            endpoint.query_pairs_mut().append_pair("url", &url);
            let mut headers = HeaderMap::new();
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", credential.expose()))
                    .map_err(|_| CapabilityBridgeError::Denied)?,
            );
            headers.insert(
                HeaderName::from_static("x-openopc-egress-proxy-secret"),
                HeaderValue::from_str(self.proxy_secret.expose())
                    .map_err(|_| CapabilityBridgeError::Unavailable)?,
            );
            headers.insert(
                HeaderName::from_static("x-openopc-mtls-verified"),
                HeaderValue::from_static("SUCCESS"),
            );
            headers.insert(
                HeaderName::from_static("x-openopc-client-cert-sha256"),
                HeaderValue::from_str(&self.certificate_thumbprint)
                    .map_err(|_| CapabilityBridgeError::Unavailable)?,
            );
            let response = self
                .transport
                .send(EgressTransportRequest {
                    method,
                    url: endpoint,
                    headers,
                    body,
                })
                .await?;
            if response.status == reqwest::StatusCode::FORBIDDEN.as_u16() {
                return Err(CapabilityBridgeError::Denied);
            }
            if response.status == reqwest::StatusCode::PAYLOAD_TOO_LARGE.as_u16() {
                return Err(CapabilityBridgeError::Limit);
            }
            if (500..=599).contains(&response.status) {
                return Err(CapabilityBridgeError::Unavailable);
            }
            Ok(CapabilityResponse {
                status: response.status,
                body: response.body,
            })
        })
    }
}

#[derive(Clone)]
pub struct ExecutionCapabilities {
    tokens: Arc<[RunnerCapabilityTokenV1]>,
    bridge: Arc<dyn CapabilityBridge>,
}

impl ExecutionCapabilities {
    pub fn new(tokens: Vec<RunnerCapabilityTokenV1>, bridge: Arc<dyn CapabilityBridge>) -> Self {
        Self {
            tokens: tokens.into(),
            bridge,
        }
    }

    pub async fn http(
        &self,
        capability_index: u32,
        method: String,
        url: String,
        body: Vec<u8>,
    ) -> Result<CapabilityResponse, CapabilityBridgeError> {
        if method.is_empty()
            || method.len() > MAX_METHOD_BYTES
            || url.is_empty()
            || url.len() > MAX_URL_BYTES
            || body.len() > MAX_CAPABILITY_BODY_BYTES
        {
            return Err(CapabilityBridgeError::Limit);
        }
        let credential = self.credential(capability_index, CapabilityAudience::Egress)?;
        self.invoke(CapabilityRequest::Http {
            capability_index,
            credential,
            method,
            url,
            body,
        })
        .await
    }

    pub async fn secret_use(
        &self,
        capability_index: u32,
        action: String,
        payload: Vec<u8>,
    ) -> Result<CapabilityResponse, CapabilityBridgeError> {
        if action.is_empty()
            || action.len() > MAX_OPERATION_BYTES
            || payload.len() > MAX_CAPABILITY_BODY_BYTES
        {
            return Err(CapabilityBridgeError::Limit);
        }
        let credential = self.credential(capability_index, CapabilityAudience::Secret)?;
        self.invoke(CapabilityRequest::SecretUse {
            capability_index,
            credential,
            action,
            payload,
        })
        .await
    }

    pub async fn model(
        &self,
        capability_index: u32,
        operation: String,
        payload: Vec<u8>,
    ) -> Result<CapabilityResponse, CapabilityBridgeError> {
        if operation.is_empty()
            || operation.len() > MAX_OPERATION_BYTES
            || payload.len() > MAX_CAPABILITY_BODY_BYTES
        {
            return Err(CapabilityBridgeError::Limit);
        }
        let credential = self.credential(capability_index, CapabilityAudience::Model)?;
        self.invoke(CapabilityRequest::Model {
            capability_index,
            credential,
            operation,
            payload,
        })
        .await
    }

    fn credential(
        &self,
        capability_index: u32,
        expected_audience: CapabilityAudience,
    ) -> Result<CapabilityCredential, CapabilityBridgeError> {
        let token = usize::try_from(capability_index)
            .ok()
            .and_then(|index| self.tokens.get(index))
            .filter(|token| token.audience == expected_audience)
            .ok_or(CapabilityBridgeError::Denied)?;
        Ok(CapabilityCredential::new(token.token.clone()))
    }

    async fn invoke(
        &self,
        request: CapabilityRequest,
    ) -> Result<CapabilityResponse, CapabilityBridgeError> {
        let response = self.bridge.invoke(request).await?;
        if response.body.len() > MAX_CAPABILITY_BODY_BYTES {
            return Err(CapabilityBridgeError::Limit);
        }
        Ok(response)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DenyCapabilityBridge;

impl CapabilityBridge for DenyCapabilityBridge {
    fn invoke<'a>(&'a self, _request: CapabilityRequest) -> CapabilityFuture<'a> {
        Box::pin(async { Err(CapabilityBridgeError::Unavailable) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_body_buffer_rejects_a_chunk_before_exceeding_the_limit() {
        let mut buffer = ResponseBodyBuffer::default();
        buffer.push(&vec![0; MAX_CAPABILITY_BODY_BYTES]).unwrap();

        assert!(matches!(
            buffer.push(&[1]),
            Err(CapabilityBridgeError::Limit)
        ));
        assert_eq!(buffer.into_body().len(), MAX_CAPABILITY_BODY_BYTES);
    }
}
