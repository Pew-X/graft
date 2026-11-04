#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly

//! The start-up run, against the real artefact and a tampered table.

use graft_host_check::{build_snapshot, route};
use graft_vectors::table::Table;
use std::path::PathBuf;
use std::process::Command;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Built and read once per test binary. Tests run in parallel, and every cargo invocation briefly
/// re-links the output file, so a test that read it while another built it saw "not found".
fn artefact() -> Vec<u8> {
    static BUILT: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    BUILT.get_or_init(build_artefact).clone()
}

fn build_artefact() -> Vec<u8> {
    let status = Command::new("sh")
        .arg(root().join("scripts/build-wasm.sh"))
        .status()
        .expect("build");
    assert!(status.success());
    std::fs::read(root().join("target/wasm32-unknown-unknown/wasm/graft_render.wasm"))
        .expect("read")
}

fn table_text() -> String {
    std::fs::read_to_string(root().join("fixtures/vectors/vectors.json")).expect("table")
}

fn no_env(_: &str) -> Option<String> {
    None
}

#[test]
fn the_real_artefact_and_table_give_a_healthy_snapshot_with_the_numbers_we_need() {
    let table = Table::parse(&table_text()).expect("table");
    let snap = build_snapshot(&artefact(), &table, &|n| {
        (n == "AWS_REGION").then(|| "test".to_string())
    })
    .expect("snapshot");
    assert!(snap.healthy, "{}", snap.results_json);
    let doc: serde_json::Value = serde_json::from_str(&snap.results_json).expect("json");
    assert_eq!(doc["checks"]["failed"], 0);
    assert!(doc["checks"]["total"].as_u64().expect("count") > 100);
    assert_eq!(doc["renderer"]["version"], 1);
    assert_eq!(doc["instance"]["region"], "test");
    assert_eq!(doc["measurements"].as_array().expect("array").len(), 6);
    assert!(
        doc["cold_start_ms"]["load_and_compile_and_pin_check"]
            .as_f64()
            .expect("ms")
            > 0.0
    );
    assert_eq!(route("GET", "/health", &snap).status, 200);
}

#[test]
fn a_wrong_expected_hash_makes_the_service_unhealthy_and_names_the_vector() {
    let tampered = table_text().replace(
        "d00e6d93ef56987fc9a41bcbb5ed7a8b0529bc8fef8b15bee10ab98d6ea93e38",
        &"0".repeat(64),
    );
    let snap = build_snapshot(
        &artefact(),
        &Table::parse(&tampered).expect("table"),
        &no_env,
    )
    .expect("snapshot");
    assert!(!snap.healthy);
    assert!(
        snap.results_json.contains("vector up3/2-cr"),
        "{}",
        snap.results_json
    );
    assert_eq!(route("GET", "/health", &snap).status, 503);
}

#[test]
fn an_artefact_that_is_not_the_pinned_renderer_is_rejected_not_served() {
    let table = Table::parse(&table_text()).expect("table");
    let mut wasm = artefact();
    wasm.extend_from_slice(&[0x00, 0x01, 0x02]); // any byte change: invalid or unpinned, never served
    let err = build_snapshot(&wasm, &table, &no_env).expect_err("must refuse");
    assert!(err.contains("artefact rejected"), "{err}");
}
