use serde::Serialize;
use serde_json::{Value, json};

use crate::evidence::evidence_digest;

const MAX_EVENTS: usize = 128;
const MAX_LABEL_BYTES: usize = 128;
const MAX_LOG_MESSAGE_BYTES: usize = 16_384;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasiEvidenceEvent {
    pub category: String,
    pub digest: String,
}

#[derive(Default)]
pub struct WasiEvidenceRecorder {
    events: Vec<WasiEvidenceEvent>,
}

impl WasiEvidenceRecorder {
    pub fn record_log(&mut self, level: &str, message: &str) -> u32 {
        if !valid_label(level) || message.len() > MAX_LOG_MESSAGE_BYTES {
            return 1;
        }
        self.record("log", json!({ "level": level, "message": message }))
    }

    pub fn record_usage(&mut self, kind: &str, units: u64) -> u32 {
        if !valid_label(kind) {
            return 1;
        }
        self.record("usage", json!({ "kind": kind, "units": units }))
    }

    pub(crate) fn record_capability(
        &mut self,
        category: &str,
        request_digest: String,
        result_code: u32,
        response_digest: Option<String>,
    ) {
        let _ = self.record(
            category,
            json!({
                "requestDigest": request_digest,
                "responseDigest": response_digest,
                "resultCode": result_code,
            }),
        );
    }

    pub fn into_events(self) -> Vec<WasiEvidenceEvent> {
        self.events
    }

    fn record(&mut self, category: &str, payload: Value) -> u32 {
        if self.events.len() >= MAX_EVENTS || !valid_label(category) {
            return 1;
        }
        let Ok(digest) = evidence_digest(&payload) else {
            return 1;
        };
        self.events.push(WasiEvidenceEvent {
            category: category.to_owned(),
            digest,
        });
        0
    }
}

fn valid_label(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_LABEL_BYTES && !value.chars().any(char::is_control)
}
