#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly

//! The host never trusts the module. Each test loads a small hand-written module that misbehaves in
//! one way and checks the host reports a typed error and stays usable.
//! (The real renderer's behaviour through the host is covered in `graft-vectors`.)

use graft_render_host::{
    ArtefactError, Limits, Method, Pins, Ratio, Render, RenderError, RenderHost,
};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

/// A module with the renderer's export surface and a bump allocator. `render_body` is the body of
/// `graft_render` (params: in_ptr in_len p q method out_ptr out_cap).
fn module(version: i32, render_body: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 1024))
          (func (export "graft_version") (result i32) (i32.const {version}))
          (func (export "graft_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (if (i32.gt_u (global.get $bump) (i32.mul (memory.size) (i32.const 65536)))
              (then
                (if (i32.eq (memory.grow (i32.add (i32.div_u (local.get $n) (i32.const 65536)) (i32.const 1)))
                            (i32.const -1))
                  (then (return (i32.const 0))))))
            (local.get $p))
          (func (export "graft_free") (param i32 i32))
          (func (export "graft_out_len") (param i32 i32 i32) (result i32) (local.get 0))
          (func (export "graft_render") (param i32 i32 i32 i32 i32 i32 i32) (result i32)
            {render_body}))"#
    ))
    .expect("fixture assembles")
}

const ECHO: &str = "(local.get 1)"; // reports in_len frames written; the frames are zeros
const ENDLESS: &str = "(loop $l (br $l)) (i32.const 0)";
const TRAP_ON_METHOD_9: &str =
    "(if (i32.eq (local.get 4) (i32.const 9)) (then unreachable)) (local.get 1)";
const NEGATIVE_CODE: &str = "(i32.const -7)";
const MEMORY_BOMB: &str = "(loop $l (if (i32.ne (memory.grow (i32.const 16)) (i32.const -1)) (then (br $l)))) (local.get 1)";

fn host(wasm: &[u8], limits: Limits) -> RenderHost {
    RenderHost::load_unpinned(wasm, limits).expect("fixture loads")
}

const HALF: Ratio = Ratio { p: 1, q: 1 };

#[test]
fn a_runaway_render_is_interrupted_within_a_time_bound() {
    let h = host(
        &module(77, ENDLESS),
        Limits {
            max_fuel: 50_000_000,
            ..Limits::default()
        },
    );
    let started = Instant::now();
    let result = h.render(&[1, 2, 3], HALF, Method::Hermite);
    assert_eq!(result, Err(RenderError::Interrupted));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );
}

#[test]
fn a_trap_is_a_typed_error_and_the_next_render_still_works() {
    let h = host(&module(77, TRAP_ON_METHOD_9), Limits::default());
    let trapped = h.render_raw(&[1, 2, 3], 1, 1, 9, 3);
    assert!(
        matches!(trapped, Err(RenderError::Trapped(_))),
        "got {trapped:?}"
    );
    assert_eq!(h.render_raw(&[1, 2, 3], 1, 1, 1, 3), Ok(vec![0, 0, 0]));
}

#[test]
fn a_negative_code_the_contract_does_not_define_is_an_internal_failure() {
    let h = host(&module(77, NEGATIVE_CODE), Limits::default());
    assert!(matches!(
        h.render(&[1], HALF, Method::Linear),
        Err(RenderError::Internal(_))
    ));
}

#[test]
fn growing_past_the_memory_limit_is_a_typed_error() {
    let limits = Limits {
        max_memory_bytes: 1 << 20,
        ..Limits::default()
    };
    let h = host(&module(77, MEMORY_BOMB), limits);
    assert_eq!(
        h.render(&[1, 2, 3], HALF, Method::Linear),
        Err(RenderError::MemoryLimit)
    );
}

#[test]
fn an_input_that_cannot_fit_the_memory_limit_is_refused_not_a_panic() {
    let limits = Limits {
        max_memory_bytes: 1 << 20,
        ..Limits::default()
    };
    let h = host(&module(77, ECHO), limits);
    let big = vec![0i16; 4 << 20];
    assert_eq!(
        h.render(&big, HALF, Method::Linear),
        Err(RenderError::MemoryLimit)
    );
}

#[test]
fn no_state_leaks_between_renders() {
    let h = host(&module(77, ECHO), Limits::default());
    let a = h.render(&[5; 100], HALF, Method::Linear);
    let b = h.render(&[9; 10], HALF, Method::Hermite);
    assert_eq!(a, h.render(&[5; 100], HALF, Method::Linear));
    assert_eq!(b, h.render(&[9; 10], HALF, Method::Hermite));
}

#[test]
fn many_threads_get_identical_results_from_one_shared_host() {
    let h = host(&module(77, ECHO), Limits::default());
    let expected = h.render(&[3; 500], HALF, Method::Hermite).expect("renders");
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..16)
            .map(|_| {
                s.spawn(|| {
                    (0..20)
                        .map(|_| h.render(&[3; 500], HALF, Method::Hermite))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for handle in handles {
            for result in handle.join().expect("thread") {
                assert_eq!(result.as_ref(), Ok(&expected));
            }
        }
    });
}

#[test]
fn a_module_with_imports_is_refused() {
    let wasm = wat::parse_str(r#"(module (import "env" "f" (func)) (memory (export "memory") 1))"#)
        .expect("assembles");
    assert_eq!(
        RenderHost::load_unpinned(&wasm, Limits::default()).err(),
        Some(ArtefactError::HasImports(1))
    );
}

#[test]
fn a_module_missing_an_export_is_refused() {
    let wasm = wat::parse_str(r#"(module (memory (export "memory") 1))"#).expect("assembles");
    assert!(matches!(
        RenderHost::load_unpinned(&wasm, Limits::default()),
        Err(ArtefactError::MissingExport(_))
    ));
}

#[test]
fn bytes_that_are_not_a_module_are_refused() {
    assert!(matches!(
        RenderHost::load_unpinned(b"not wasm", Limits::default()),
        Err(ArtefactError::Invalid(_))
    ));
}

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn loading_checks_the_loaded_bytes_against_the_pin_for_the_version_they_report() {
    let wasm = module(77, ECHO);
    let good = Pins::parse(&format!("77 {}\n", sha_hex(&wasm))).expect("pins");
    let h =
        RenderHost::load_with_pins(&wasm, &good, Limits::default()).expect("pinned artefact loads");
    assert_eq!(h.identity().version, 77);
    assert_eq!(h.identity().wasm_sha256, sha_hex(&wasm));
    assert_eq!(h.identity().name, "graft-render");

    let other = Pins::parse(&format!("77 {}\n", "0".repeat(64))).expect("pins");
    assert!(matches!(
        RenderHost::load_with_pins(&wasm, &other, Limits::default()),
        Err(ArtefactError::PinMismatch { version: 77, .. })
    ));
    let unpinned = Pins::parse(&format!("1 {}\n", "0".repeat(64))).expect("pins");
    assert_eq!(
        RenderHost::load_with_pins(&wasm, &unpinned, Limits::default()).err(),
        Some(ArtefactError::UnpinnedVersion(77))
    );
}

#[test]
fn pin_files_reject_malformed_and_repeated_lines() {
    assert!(Pins::parse("1 nothex").is_err());
    assert!(Pins::parse(&format!("1 {0}\n1 {0}\n", "a".repeat(64))).is_err());
    assert_eq!(
        Pins::parse(&format!("# c\n\n2 {}\n", "b".repeat(64)))
            .expect("ok")
            .get(2),
        Some("b".repeat(64).as_str())
    );
}

#[test]
fn the_committed_pins_parse() {
    assert!(
        Pins::embedded()
            .expect("committed pins parse")
            .get(1)
            .is_some()
    );
}
