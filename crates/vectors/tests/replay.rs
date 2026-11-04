#![allow(clippy::expect_used)] // test helpers fail loudly

//! Seam 2: the committed vector table replayed on every host this repository can run.

use graft_vectors::native::NativeHost;
use graft_vectors::run::{Check, run_canonicalisation, run_table};
use graft_vectors::table::Table;
use graft_vectors::wasm::WasmtimeHost;
use std::path::PathBuf;
use std::process::Command;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn table() -> Table {
    Table::load(&root().join("fixtures/vectors/vectors.json")).expect("vector table loads")
}

/// The canonical artefact, always rebuilt first (cargo makes that a no-op when nothing changed) so a
/// stale file can never stand in for the current source.
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
        .expect("run scripts/build-wasm.sh");
    assert!(status.success(), "scripts/build-wasm.sh failed");
    let path = root().join("target/wasm32-unknown-unknown/wasm/graft_render.wasm");
    std::fs::read(path).expect("read the built artefact")
}

fn assert_all_pass(host: &str, checks: &[Check]) {
    let failed: Vec<String> = checks
        .iter()
        .filter(|c| !c.passed)
        .map(|c| {
            format!(
                "  {host}: {}\n    expected {}\n    actual   {}",
                c.name, c.expected, c.actual
            )
        })
        .collect();
    assert!(
        failed.is_empty(),
        "{} of {} checks failed:\n{}",
        failed.len(),
        checks.len(),
        failed.join("\n")
    );
}

#[test]
fn table_is_well_formed() {
    let t = table();
    let mut names: Vec<&str> = t.vectors.iter().map(|v| v.name.as_str()).collect();
    names.sort_unstable();
    let before = names.len();
    names.dedup();
    assert_eq!(before, names.len(), "vector names must be unique");
    assert!(
        t.vectors.iter().filter(|v| v.expect.status < 0).count() >= 10,
        "error vectors present"
    );
    assert_eq!(
        t.vectors
            .iter()
            .filter(|v| v.name.starts_with("hand-"))
            .count(),
        4
    );
}

#[test]
fn native_renderer_reproduces_every_vector() {
    assert_all_pass("native", &run_table(&table(), &mut NativeHost));
}

#[test]
fn wasm_artefact_under_wasmtime_reproduces_every_vector() {
    let mut host = WasmtimeHost::new(&artefact()).expect("artefact instantiates with no imports");
    assert_all_pass("wasmtime", &run_table(&table(), &mut host));
}

#[test]
fn canonicalisation_rules_match_their_vectors() {
    assert_all_pass("canon", &run_canonicalisation(&table()));
}

#[test]
fn large_renders_really_grow_the_instance_memory() {
    // The growth scenario only means something if one instance's memory actually grows.
    use graft_vectors::host::Host;
    let t = table();
    let big = t.vector("big-cr").expect("big-cr exists");
    let mut host = WasmtimeHost::new(&artefact()).expect("artefact instantiates");
    let before = host.memory_pages().expect("wasm hosts report pages");
    let _ = host.render(&big.input.generate(), big.p, big.q, big.method, big.out_cap);
    let after = host.memory_pages().expect("wasm hosts report pages");
    assert!(
        after > before,
        "memory stayed at {before} pages after a 2^21 frame render"
    );
}

#[test]
fn table_belongs_to_the_renderer_version_being_built() {
    let t = table();
    assert_eq!(t.renderer.name, graft_render::NAME);
    assert_eq!(
        t.renderer.version,
        graft_render::VERSION,
        "regenerate the table for a new version"
    );
}

#[test]
fn render_host_reproduces_every_vector_through_the_service_code_path() {
    // `HostedRenderer::load` checks the artefact against the committed pins first, so this also shows
    // the pin file and the built bytes agree.
    let mut host =
        graft_vectors::hosted::HostedRenderer::load(&artefact()).expect("artefact matches the pin");
    let checks = run_table(&table(), &mut host);
    assert_all_pass("render-host", &checks);
}

#[test]
fn render_host_gives_identical_bytes_for_render_a_b_a_and_across_threads() {
    use graft_render_host::{Limits, Method, Ratio, Render, RenderHost};
    let host = RenderHost::load(&artefact(), Limits::default()).expect("loads");
    let t = table();
    let noise = |name: &str| t.vector(name).expect("vector").input.generate();
    let (a_in, b_in) = (noise("up3/2-cr"), noise("dn2/3-cr"));
    let a = host
        .render(&a_in, Ratio { p: 3, q: 2 }, Method::Hermite)
        .expect("a");
    let b = host
        .render(&b_in, Ratio { p: 2, q: 3 }, Method::Hermite)
        .expect("b");
    assert_eq!(
        host.render(&a_in, Ratio { p: 3, q: 2 }, Method::Hermite)
            .expect("a again"),
        a
    );
    assert_ne!(a, b);
    std::thread::scope(|s| {
        let runs: Vec<_> = (0..12)
            .map(|_| {
                s.spawn(|| {
                    (0..5)
                        .map(|_| host.render(&a_in, Ratio { p: 3, q: 2 }, Method::Hermite))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for run in runs {
            for result in run.join().expect("thread") {
                assert_eq!(result.as_ref(), Ok(&a));
            }
        }
    });
    assert_eq!(host.identity().version, graft_render::VERSION);
}

#[test]
fn the_most_expensive_accepted_render_is_interrupted_when_its_fuel_budget_is_too_small() {
    // The vector is 480,000 frames at 1/4 speed (about 4.1e8 fuel), a long one but no longer the costliest the
    // service accepts: the 30 s limits allow more (see the next test).
    use graft_render_host::{Limits, Method, Ratio, Render, RenderError, RenderHost};
    let host = RenderHost::load(
        &artefact(),
        Limits {
            max_fuel: 100_000_000,
            ..Limits::default()
        },
    )
    .expect("loads");
    let t = table();
    let v = t.vector("cut-cap-quarter").expect("vector");
    let started = std::time::Instant::now();
    let result = host.render(
        &v.input.generate(),
        Ratio { p: v.p, q: v.q },
        Method::Hermite,
    );
    assert_eq!(result, Err(RenderError::Interrupted));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[test]
fn the_costliest_render_the_service_accepts_fits_the_default_fuel_budget_with_room() {
    // A 30 s cut at half speed is the longest output the service allows (60 s, 2,879,999 frames): measured
    // at about 6.2e8 fuel against the default budget of 1e9. It must render with the default limits.
    use graft_render_host::{Limits, Method, Ratio, Render, RenderHost};
    let host = RenderHost::load(&artefact(), Limits::default()).expect("loads");
    let input = graft_vectors::measure::noise(1_440_000);
    let (out, stats) = host
        .render_with_stats(&input, Ratio { p: 1, q: 2 }, Method::Hermite)
        .expect("renders within the default budget");
    assert_eq!(out.len(), 2_879_999);
    assert!(
        stats.fuel_used < Limits::default().max_fuel / 10 * 8,
        "the worst accepted render should leave at least 20% of the fuel budget, used {}",
        stats.fuel_used
    );
}
