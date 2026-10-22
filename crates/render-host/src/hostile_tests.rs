//! The host never trusts the module. Each test loads a small hand-written module that misbehaves in
//! one way and checks the host reports a typed error and stays usable.
//! (The real renderer's behaviour through the host is covered in `graft-vectors`.)

#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly

use crate::host::sha256_hex as sha_hex;
use crate::{ArtefactError, Limits, Method, Pins, Ratio, Render, RenderError, RenderHost};
use std::time::{Duration, Instant};

/// A module with the renderer's export surface and a bump allocator. `render_body` is the body of
/// `graft_render` (params: in_ptr in_len p q method out_ptr out_cap).
fn module(version: i32, render_body: &str) -> Vec<u8> {
    module_with(version, "", render_body)
}

fn module_with(version: i32, declarations: &str, render_body: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 1024))
          {declarations}
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

/// Copies the input to the output, then adds a per-instance call counter to the first frame and
/// increments it. A fresh instance always starts at zero, so the output equals the input exactly;
/// if an instance or its globals were reused between renders, the first frame would drift.
const COUNTING_COPY_DECL: &str = "(global $calls (mut i32) (i32.const 0))";
const COUNTING_COPY: &str =
    "(memory.copy (local.get 5) (local.get 0) (i32.mul (local.get 1) (i32.const 2)))
   (i32.store16 (local.get 5)
     (i32.add (i32.load16_s (local.get 5)) (global.get $calls)))
   (global.set $calls (i32.add (global.get $calls) (i32.const 1)))
   (local.get 1)";

fn counting_copy_host() -> RenderHost {
    host(
        &module_with(77, COUNTING_COPY_DECL, COUNTING_COPY),
        Limits::default(),
    )
}
const ENDLESS: &str = "(loop $l (br $l)) (i32.const 0)";
const TRAP_ON_METHOD_9: &str =
    "(if (i32.eq (local.get 4) (i32.const 9)) (then unreachable)) (local.get 1)";
const NEGATIVE_CODE: &str = "(i32.const -7)";
const MEMORY_BOMB: &str = "(loop $l (if (i32.ne (memory.grow (i32.const 16)) (i32.const -1)) (then (br $l)))) (local.get 1)";

fn host(wasm: &[u8], limits: Limits) -> RenderHost {
    RenderHost::load_unpinned(wasm, limits).expect("fixture loads")
}

const ONE: Ratio = Ratio { p: 1, q: 1 };

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
    let result = h.render(&[1, 2, 3], ONE, Method::Hermite);
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
        h.render(&[1], ONE, Method::Linear),
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
        h.render(&[1, 2, 3], ONE, Method::Linear),
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
        h.render(&big, ONE, Method::Linear),
        Err(RenderError::MemoryLimit)
    );
}

#[test]
fn no_state_leaks_between_renders() {
    let h = counting_copy_host();
    let (a_in, b_in) = ([5i16; 100], [9i16; 10]);
    // Every render sees a fresh instance, so the counter is always zero and the copy is exact.
    for _ in 0..3 {
        assert_eq!(h.render(&a_in, ONE, Method::Linear), Ok(a_in.to_vec()));
        assert_eq!(h.render(&b_in, ONE, Method::Hermite), Ok(b_in.to_vec()));
    }
}

#[test]
fn many_threads_get_identical_results_from_one_shared_host() {
    let h = counting_copy_host();
    let input: Vec<i16> = (0..500).map(|i| i * 3).collect();
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..16)
            .map(|_| {
                s.spawn(|| {
                    (0..20)
                        .map(|_| h.render(&input, ONE, Method::Hermite))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for handle in handles {
            for result in handle.join().expect("thread") {
                assert_eq!(result.as_ref(), Ok(&input));
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
    assert_eq!(
        RenderHost::load_unpinned(&wasm, Limits::default()).err(),
        Some(ArtefactError::MissingExport("graft_version"))
    );
}

#[test]
fn bytes_that_are_not_a_module_are_refused() {
    assert!(matches!(
        RenderHost::load_unpinned(b"not wasm", Limits::default()),
        Err(ArtefactError::Invalid(_))
    ));
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

#[test]
fn modules_needing_simd_or_shared_memory_are_refused() {
    // The engine is configured without SIMD and built without threads; a module that needs either
    // must not load, whatever the artefact pin says.
    let simd = module_with(77, "(global $v v128 (v128.const i32x4 0 0 0 0))", ECHO);
    assert!(matches!(
        RenderHost::load_unpinned(&simd, Limits::default()),
        Err(ArtefactError::Invalid(_))
    ));
    let shared = wat::parse_str(r#"(module (memory (export "memory") 1 1 shared))"#);
    // Assembling a shared memory without the threads proposal enabled in the text parser may itself
    // fail; either way no loadable module comes out.
    if let Ok(bytes) = shared {
        assert!(matches!(
            RenderHost::load_unpinned(&bytes, Limits::default()),
            Err(ArtefactError::Invalid(_) | ArtefactError::MissingExport(_))
        ));
    }
}

#[test]
fn the_counting_fixture_does_drift_when_an_instance_is_reused() {
    // Without this, the isolation tests above could pass for a fixture that cannot show leaked state.
    use wasmtime::{Engine, Instance, Module, Store};
    let engine = Engine::default();
    let module =
        Module::new(&engine, module_with(77, COUNTING_COPY_DECL, COUNTING_COPY)).expect("compiles");
    let mut store = Store::new(&engine, ());
    let instance = Instance::new(&mut store, &module, &[]).expect("instantiates");
    let render = instance
        .get_typed_func::<(u32, u32, u32, u32, u32, u32, u32), i32>(&mut store, "graft_render")
        .expect("export");
    let memory = instance.get_memory(&mut store, "memory").expect("memory");
    // Input frames [5, 5] at byte 2048; output at byte 4096.
    memory
        .write(&mut store, 2048, &[5, 0, 5, 0])
        .expect("write");
    let first_frame = |store: &mut Store<()>| {
        render
            .call(&mut *store, (2048, 2, 1, 1, 1, 4096, 2))
            .expect("render");
        let mut bytes = [0u8; 2];
        memory.read(&*store, 4096, &mut bytes).expect("read");
        i16::from_le_bytes(bytes)
    };
    assert_eq!(first_frame(&mut store), 5);
    assert_eq!(
        first_frame(&mut store),
        6,
        "a reused instance carries its counter into the output"
    );
}
