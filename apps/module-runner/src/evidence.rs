use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_EVIDENCE_BYTES: usize = 262_144;
const MAX_DEPTH: usize = 16;
const MAX_OBJECT_FIELDS: usize = 256;
const MAX_ARRAY_ITEMS: usize = 1_024;
const MAX_STRING_BYTES: usize = 16_384;

#[derive(Debug, Error)]
pub enum EvidenceError {
    #[error("RUNNER_EVIDENCE_INVALID")]
    Invalid,
    #[error("RUNNER_EVIDENCE_SENSITIVE_FIELD")]
    SensitiveField,
    #[error("RUNNER_EVIDENCE_TOO_LARGE")]
    TooLarge,
}

pub fn sanitize_evidence(value: Value) -> Result<Value, EvidenceError> {
    validate_value(&value, 0)?;
    let encoded = serde_json::to_vec(&value).map_err(|_| EvidenceError::Invalid)?;
    if encoded.len() > MAX_EVIDENCE_BYTES {
        return Err(EvidenceError::TooLarge);
    }
    Ok(value)
}

pub fn evidence_digest(value: &Value) -> Result<String, EvidenceError> {
    let value = sanitize_evidence(value.clone())?;
    let encoded = serde_json::to_vec(&sort_json(value)).map_err(|_| EvidenceError::Invalid)?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn validate_value(value: &Value, depth: usize) -> Result<(), EvidenceError> {
    if depth > MAX_DEPTH {
        return Err(EvidenceError::TooLarge);
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(value) if value.len() <= MAX_STRING_BYTES => Ok(()),
        Value::String(_) => Err(EvidenceError::TooLarge),
        Value::Array(values) if values.len() <= MAX_ARRAY_ITEMS => {
            for value in values {
                validate_value(value, depth + 1)?;
            }
            Ok(())
        }
        Value::Array(_) => Err(EvidenceError::TooLarge),
        Value::Object(values) if values.len() <= MAX_OBJECT_FIELDS => {
            for (key, value) in values {
                if sensitive_key(key) {
                    return Err(EvidenceError::SensitiveField);
                }
                if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
                    return Err(EvidenceError::Invalid);
                }
                validate_value(value, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(_) => Err(EvidenceError::TooLarge),
    }
}

fn sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    [
        "apikey",
        "authorization",
        "capabilitytoken",
        "cookie",
        "credential",
        "password",
        "privatekey",
        "prompt",
        "providerbody",
        "rawsource",
        "secret",
        "signedurl",
    ]
    .iter()
    .any(|forbidden| normalized.contains(forbidden))
}

fn sort_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(sort_json).collect()),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.into_iter().collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, sort_json(value)))
                    .collect(),
            )
        }
        scalar => scalar,
    }
}
