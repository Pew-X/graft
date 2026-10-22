#![allow(clippy::print_stdout, clippy::expect_used)] // a command-line measurement tool
//! Measures the render host on the worst-case renders: cold start, time, fuel and memory.
//!
//!     cargo run --release -p graft-render-host --example measure -- <path to graft_render.wasm>
//!
//! Prints a markdown table. Method: each case runs once to warm the caches, then 15 timed renders;
//! the table shows the median and the slowest. Fuel and linear memory come from the host's own
//! accounting. The process high-water mark is read from `/proc/self/status` where it exists.

use graft_render_host::{Limits, Method, Ratio, Render, RenderHost};
use std::time::Instant;

fn noise(len: usize) -> Vec<i16> {
    let mut state = 12345u32;
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 16) as u16 as i16
        })
        .collect()
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: measure <graft_render.wasm>");
    let wasm = std::fs::read(path).expect("read the artefact");

    let started = Instant::now();
    let host =
        RenderHost::load(&wasm, Limits::default()).expect("artefact loads and matches its pin");
    let cold_load = started.elapsed();
    let first = Instant::now();
    host.render(&noise(1000), Ratio { p: 1, q: 1 }, Method::Hermite)
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
    let cases: [(&str, usize, u32, u32); 5] = [
        ("cut cap at speed 1", 480_000, 1, 1),
        ("speed 1/4, output at the 20 s cap", 240_000, 1, 4),
        ("speed 1/4, cut cap (beyond the output cap)", 480_000, 1, 4),
        ("speed 4, cut cap", 480_000, 4, 1),
        ("speed 4, renderer input ceiling", 1 << 21, 4, 1),
    ];
    for (name, len, p, q) in cases {
        let input = noise(len);
        let ratio = Ratio { p, q };
        host.render(&input, ratio, Method::Hermite)
            .expect("warm-up");
        let mut times = Vec::new();
        let mut stats = None;
        let mut frames = 0;
        for _ in 0..15 {
            let t = Instant::now();
            let (out, s) = host
                .render_with_stats(&input, ratio, Method::Hermite)
                .expect("render");
            times.push(t.elapsed());
            frames = out.len();
            stats = Some(s);
        }
        times.sort();
        let s = stats.expect("ran at least once");
        println!(
            "| {name} | {len} | {frames} | {:.1?} | {:.1?} | {} | {:.1} MiB |",
            times[times.len() / 2],
            times[times.len() - 1],
            s.fuel_used,
            s.peak_memory_bytes as f64 / (1 << 20) as f64,
        );
    }
    if let Ok(status) = std::fs::read_to_string("/proc/self/status")
        && let Some(line) = status.lines().find(|l| l.starts_with("VmHWM"))
    {
        println!(
            "\nprocess peak resident memory: {}",
            line.trim_start_matches("VmHWM:").trim()
        );
    }
}
