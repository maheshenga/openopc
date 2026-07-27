use openopc_module_runner::wasi::WasiEvidenceRecorder;

#[test]
fn stores_only_bounded_digests_for_guest_evidence() {
    let sensitive = "authorization=Bearer private-value";
    let mut recorder = WasiEvidenceRecorder::default();

    assert_eq!(recorder.record_log("info", sensitive), 0);
    assert_eq!(recorder.record_usage("model-tokens", 42), 0);

    let events = recorder.into_events();
    assert_eq!(events.len(), 2);
    let encoded = serde_json::to_string(&events).unwrap();
    assert!(!encoded.contains(sensitive));
    assert!(!encoded.contains("private-value"));
    assert!(
        events
            .iter()
            .all(|event| event.digest.starts_with("sha256:"))
    );
    assert!(events.iter().all(|event| event.digest.len() == 71));
}

#[test]
fn rejects_oversized_or_excess_guest_evidence() {
    let mut recorder = WasiEvidenceRecorder::default();
    assert_eq!(recorder.record_log("info", &"x".repeat(16_385)), 1);

    for index in 0..128 {
        assert_eq!(recorder.record_usage("unit", index), 0);
    }
    assert_eq!(recorder.record_usage("unit", 129), 1);
    assert_eq!(recorder.into_events().len(), 128);
}
