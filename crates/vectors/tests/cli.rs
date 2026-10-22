#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly

//! The replay command, run as a user would run it.

use std::path::PathBuf;
use std::process::{Command, Output};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn artefact() -> PathBuf {
    let status = Command::new("sh")
        .arg(root().join("scripts/build-wasm.sh"))
        .status()
        .expect("build");
    assert!(status.success());
    root().join("target/wasm32-unknown-unknown/wasm/graft_render.wasm")
}

fn replay(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_vectors-replay"))
        .args(args)
        .current_dir(root())
        .output()
        .expect("run vectors-replay")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn a_correct_artefact_passes_every_check_and_exits_zero() {
    let wasm = artefact();
    for host in ["wasmtime", "render-host"] {
        let out = replay(&["--host", host, wasm.to_str().expect("utf8")]);
        assert_eq!(out.status.code(), Some(0), "{host}: {}", text(&out.stdout));
        assert!(
            text(&out.stdout).contains("0 failed"),
            "{}",
            text(&out.stdout)
        );
    }
    let native = replay(&["--host", "native"]);
    assert_eq!(native.status.code(), Some(0), "{}", text(&native.stdout));
}

#[test]
fn a_changed_expected_hash_fails_names_the_vector_and_shows_both_hashes() {
    let table =
        std::fs::read_to_string(root().join("fixtures/vectors/vectors.json")).expect("table");
    let real = "d00e6d93ef56987fc9a41bcbb5ed7a8b0529bc8fef8b15bee10ab98d6ea93e38"; // up3/2-cr
    assert!(table.contains(real));
    let fake = "0".repeat(64);
    let dir = std::env::temp_dir().join(format!("graft-replay-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let tampered = dir.join("vectors.json");
    std::fs::write(&tampered, table.replace(real, &fake)).expect("write");
    let out = replay(&[
        "--host",
        "native",
        "--table",
        tampered.to_str().expect("utf8"),
    ]);
    let stdout = text(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{stdout}");
    assert!(stdout.contains("FAIL  vector up3/2-cr"), "{stdout}");
    assert!(stdout.contains(&fake) && stdout.contains(real), "{stdout}");
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn an_artefact_that_is_not_the_renderer_fails_to_load_with_exit_three() {
    let dir = std::env::temp_dir().join(format!("graft-replay-bad-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let bad = dir.join("bad.wasm");
    std::fs::write(&bad, b"not wasm").expect("write");
    let out = replay(&[bad.to_str().expect("utf8")]);
    assert_eq!(out.status.code(), Some(3), "{}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains("cannot load"),
        "{}",
        text(&out.stderr)
    );
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn bad_usage_exits_two_and_prints_the_help() {
    for args in [
        &["--bogus"][..],
        &["--host", "carrier-pigeon", "x.wasm"][..],
        &[][..],
    ] {
        let out = replay(args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(text(&out.stderr).contains("USAGE"), "{}", text(&out.stderr));
    }
    let help = replay(&["--help"]);
    assert_eq!(help.status.code(), Some(0));
    assert!(text(&help.stdout).contains("Exit status"));
}

#[test]
fn emit_writes_the_raw_output_whose_hash_is_the_vectors_hash() {
    use graft_vectors::run::sha256_pcm;
    let out = replay(&["--host", "native", "--emit", "up3/2-cr"]);
    assert_eq!(out.status.code(), Some(0));
    let frames: Vec<i16> = out
        .stdout
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    assert_eq!(frames.len(), 32000);
    assert_eq!(
        sha256_pcm(&frames),
        "d00e6d93ef56987fc9a41bcbb5ed7a8b0529bc8fef8b15bee10ab98d6ea93e38"
    );
}

#[test]
fn only_filters_checks_by_name() {
    let out = replay(&["--host", "native", "--only", "err-p-zero"]);
    let stdout = text(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "{stdout}");
    assert!(stdout.contains("1 passed, 0 failed"), "{stdout}");
}
