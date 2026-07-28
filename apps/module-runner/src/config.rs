use std::collections::{HashMap, HashSet};
use std::env;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use thiserror::Error;
use url::Url;
use uuid::Uuid;

use crate::protocol::RuntimeKind;

pub const RUNNER_CONTRACT_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunnerProfile {
    pub runtime_kind: RuntimeKind,
    pub profile_name: String,
}

#[derive(Clone, Debug)]
pub struct RunnerConfig {
    pub control_plane_url: Url,
    pub control_plane_public_key_file: PathBuf,
    pub control_plane_key_id: String,
    pub node_identity: String,
    pub runner_id: Uuid,
    pub account_id: Uuid,
    pub mtls_certificate_file: PathBuf,
    pub mtls_private_key_file: PathBuf,
    pub profiles: Vec<RunnerProfile>,
    pub contract_version: u32,
    pub software_version: String,
    pub attestation_digest: String,
    pub capacity: u16,
    pub drain: bool,
    pub listen_addr: SocketAddr,
    pub wasmtime_identity: Option<String>,
    pub oci_profile_status: EngineStatus,
    pub shutdown_timeout: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineStatus {
    Ready,
    Unavailable,
    Disabled,
}

#[derive(Debug, Error)]
#[error("MODULE_RUNNER_CONFIGURATION_INVALID: {field}")]
pub struct RunnerConfigError {
    field: &'static str,
}

impl RunnerConfig {
    pub fn from_env() -> Result<Self, RunnerConfigError> {
        let values = env::vars().collect();
        Self::from_map(&values)
    }

    pub fn from_map(values: &HashMap<String, String>) -> Result<Self, RunnerConfigError> {
        if required(values, "OPENOPC_MODULE_RUNNER_ENABLED")? != "true" {
            return invalid("OPENOPC_MODULE_RUNNER_ENABLED");
        }
        let control_plane_url = Url::parse(required(values, "OPENOPC_RUNNER_CONTROL_PLANE_URL")?)
            .map_err(|_| error("OPENOPC_RUNNER_CONTROL_PLANE_URL"))?;
        if control_plane_url.scheme() != "https"
            || control_plane_url.host_str().is_none()
            || !control_plane_url.username().is_empty()
            || control_plane_url.password().is_some()
            || control_plane_url.query().is_some()
            || control_plane_url.fragment().is_some()
        {
            return invalid("OPENOPC_RUNNER_CONTROL_PLANE_URL");
        }
        let control_plane_public_key_file =
            required_file(values, "OPENOPC_RUNNER_CONTROL_PLANE_PUBLIC_KEY_FILE")?;
        let mtls_certificate_file = required_file(values, "OPENOPC_RUNNER_MTLS_CERT_FILE")?;
        let mtls_private_key_file = required_file(values, "OPENOPC_RUNNER_MTLS_KEY_FILE")?;
        let control_plane_key_id =
            bounded_identifier(values, "OPENOPC_RUNNER_CONTROL_PLANE_KEY_ID", 128)?;
        let node_identity = bounded_identifier(values, "OPENOPC_RUNNER_NODE_IDENTITY", 255)?;
        let runner_id = required_uuid(values, "OPENOPC_RUNNER_ID")?;
        let account_id = required_uuid(values, "OPENOPC_RUNNER_ACCOUNT_ID")?;
        let contract_version = required(values, "OPENOPC_RUNNER_CONTRACT_VERSION")?
            .parse::<u32>()
            .map_err(|_| error("OPENOPC_RUNNER_CONTRACT_VERSION"))?;
        if contract_version != RUNNER_CONTRACT_VERSION {
            return invalid("OPENOPC_RUNNER_CONTRACT_VERSION");
        }
        let software_version = bounded_identifier(values, "OPENOPC_RUNNER_SOFTWARE_VERSION", 128)?;
        let attestation_digest = required(values, "OPENOPC_RUNNER_ATTESTATION_DIGEST")?.to_owned();
        if !valid_sha256(&attestation_digest) {
            return invalid("OPENOPC_RUNNER_ATTESTATION_DIGEST");
        }
        let capacity = required(values, "OPENOPC_RUNNER_CAPACITY")?
            .parse::<u16>()
            .map_err(|_| error("OPENOPC_RUNNER_CAPACITY"))?;
        if !(1..=256).contains(&capacity) {
            return invalid("OPENOPC_RUNNER_CAPACITY");
        }
        let drain = optional_bool(values, "OPENOPC_RUNNER_DRAIN", false)?;
        let listen_addr = values
            .get("OPENOPC_RUNNER_LISTEN_ADDR")
            .map(String::as_str)
            .unwrap_or("127.0.0.1:8080")
            .parse()
            .map_err(|_| error("OPENOPC_RUNNER_LISTEN_ADDR"))?;
        let profiles = parse_profiles(required(values, "OPENOPC_RUNNER_SUPPORTED_PROFILES")?)?;
        let wasmtime_identity =
            optional_identifier(values, "OPENOPC_RUNNER_WASMTIME_IDENTITY", 256)?;
        let oci_profile_status = parse_engine_status(
            values
                .get("OPENOPC_RUNNER_OCI_PROFILE_STATUS")
                .map(String::as_str)
                .unwrap_or("disabled"),
        )?;
        let shutdown_timeout = Duration::from_millis(optional_bounded_u64(
            values,
            "OPENOPC_RUNNER_SHUTDOWN_TIMEOUT_MS",
            30_000,
            1_000,
            300_000,
        )?);
        Ok(Self {
            control_plane_url,
            control_plane_public_key_file,
            control_plane_key_id,
            node_identity,
            runner_id,
            account_id,
            mtls_certificate_file,
            mtls_private_key_file,
            profiles,
            contract_version,
            software_version,
            attestation_digest,
            capacity,
            drain,
            listen_addr,
            wasmtime_identity,
            oci_profile_status,
            shutdown_timeout,
        })
    }
}

fn required<'a>(
    values: &'a HashMap<String, String>,
    name: &'static str,
) -> Result<&'a str, RunnerConfigError> {
    values
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| error(name))
}

fn required_file(
    values: &HashMap<String, String>,
    name: &'static str,
) -> Result<PathBuf, RunnerConfigError> {
    let path = PathBuf::from(required(values, name)?);
    if !non_empty_file(&path) {
        return invalid(name);
    }
    Ok(path)
}

fn non_empty_file(path: &Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
}

fn required_uuid(
    values: &HashMap<String, String>,
    name: &'static str,
) -> Result<Uuid, RunnerConfigError> {
    Uuid::parse_str(required(values, name)?).map_err(|_| error(name))
}

fn bounded_identifier(
    values: &HashMap<String, String>,
    name: &'static str,
    max: usize,
) -> Result<String, RunnerConfigError> {
    let value = required(values, name)?;
    if !valid_identifier(value, max) {
        return invalid(name);
    }
    Ok(value.to_owned())
}

fn optional_identifier(
    values: &HashMap<String, String>,
    name: &'static str,
    max: usize,
) -> Result<Option<String>, RunnerConfigError> {
    match values.get(name).filter(|value| !value.trim().is_empty()) {
        Some(value) if valid_identifier(value, max) => Ok(Some(value.clone())),
        Some(_) => invalid(name),
        None => Ok(None),
    }
}

fn valid_identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.starts_with(|character: char| character.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:/@+-".contains(character))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn optional_bool(
    values: &HashMap<String, String>,
    name: &'static str,
    default: bool,
) -> Result<bool, RunnerConfigError> {
    match values.get(name).map(String::as_str) {
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => invalid(name),
        None => Ok(default),
    }
}

fn optional_bounded_u64(
    values: &HashMap<String, String>,
    name: &'static str,
    default: u64,
    minimum: u64,
    maximum: u64,
) -> Result<u64, RunnerConfigError> {
    match values.get(name) {
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|value| (minimum..=maximum).contains(value))
            .ok_or_else(|| error(name)),
        None => Ok(default),
    }
}

fn parse_profiles(value: &str) -> Result<Vec<RunnerProfile>, RunnerConfigError> {
    let mut seen = HashSet::new();
    let mut profiles = Vec::new();
    for entry in value.split(',') {
        let Some((runtime_kind, profile_name)) = entry.split_once(':') else {
            return invalid("OPENOPC_RUNNER_SUPPORTED_PROFILES");
        };
        let runtime_kind = match runtime_kind {
            "wasi-component" => RuntimeKind::WasiComponent,
            "oci-image" => RuntimeKind::OciImage,
            _ => return invalid("OPENOPC_RUNNER_SUPPORTED_PROFILES"),
        };
        if !valid_profile(profile_name) || !seen.insert((runtime_kind, profile_name)) {
            return invalid("OPENOPC_RUNNER_SUPPORTED_PROFILES");
        }
        profiles.push(RunnerProfile {
            runtime_kind,
            profile_name: profile_name.to_owned(),
        });
    }
    if profiles.is_empty() || profiles.len() > 32 {
        return invalid("OPENOPC_RUNNER_SUPPORTED_PROFILES");
    }
    Ok(profiles)
}

fn valid_profile(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.starts_with(|character: char| character.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

fn parse_engine_status(value: &str) -> Result<EngineStatus, RunnerConfigError> {
    match value {
        "ready" => Ok(EngineStatus::Ready),
        "unavailable" => Ok(EngineStatus::Unavailable),
        "disabled" => Ok(EngineStatus::Disabled),
        _ => invalid("OPENOPC_RUNNER_OCI_PROFILE_STATUS"),
    }
}

fn error(field: &'static str) -> RunnerConfigError {
    RunnerConfigError { field }
}

fn invalid<T>(field: &'static str) -> Result<T, RunnerConfigError> {
    Err(error(field))
}
