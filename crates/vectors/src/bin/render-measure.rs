#![allow(clippy::print_stdout, clippy::expect_used)] // a command-line measurement tool
//! Measures the render host on the worst-case renders: cold start, time, fuel and memory.
//!
//!     cargo run --release -p graft-vectors --bin render-measure -- <path to graft_render.wasm>
//!
//! Prints a markdown table. Method: each case runs once to warm the caches, then 15 timed renders;
//! the table shows the median and the slowest. Fuel and linear memory come from the host's own
//! accounting; the process high-water mark is read from `/proc/self/status` where it exists.

use graft_render_host::{Limits, Method, Ratio, Render, RenderHost};
use graft_vectors::measure;
use std::time::Instant;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: render-measure <graft_render.wasm>");
    let wasm = std::fs::read(path).expect("read the artefact");

    let started = Instant::now();
    let host =
        RenderHost::load(&wasm, Limits::default()).expect("artefact loads and matches its pin");
    let cold_load = started.elapsed();
    let first = Instant::now();
    host.render(&measure::noise(1000), Ratio { p: 1, q: 1 }, Method::Hermite)
        .expect("first render");
    let cold_render = first.elapsed();

    println!(
        "renderer version {} ({})",
        host.identity().version,
        host.identity().wasm_sha256
    );
    println!("cold start: load and compile {cold_load:.2?}, first render {cold_render:.2?}\n");
    println!("| case | input frames | output frames | median | slowest | fuel | linear memory |");
    println!("|---|---|---|---|---|---|---|");
    for c in measure::run(&host, 15).expect("measurements run") {
        println!(
            "| {} | {} | {} | {:.1?} | {:.1?} | {} | {:.1} MiB |",
            c.name,
            c.input_frames,
            c.output_frames,
            c.median,
            c.slowest,
            c.fuel,
            c.memory_bytes as f64 / (1 << 20) as f64,
        );
    }
    if let Some(kb) = measure::peak_rss_kb() {
        println!("\nprocess peak resident memory: {kb} kB");
    }
}
