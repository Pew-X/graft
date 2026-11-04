//! Worst-case render measurements, shared by the `render-measure` command and the host check service.

use graft_render_host::{Method, Ratio, Render, RenderHost};
use std::time::{Duration, Instant};

/// One measured case.
#[derive(Debug, Clone)]
pub struct CaseResult {
    /// What the case is.
    pub name: &'static str,
    /// Input frames.
    pub input_frames: usize,
    /// Output frames.
    pub output_frames: usize,
    /// Median of the timed renders.
    pub median: Duration,
    /// Slowest timed render.
    pub slowest: Duration,
    /// Fuel the host counted.
    pub fuel: u64,
    /// Linear memory held at the end of the render, in bytes.
    pub memory_bytes: usize,
}

/// Name, input frames, p, q for the cases that bound what the renderer will accept.
pub const CASES: [(&str, usize, u32, u32); 6] = [
    ("cut cap at speed 1", 1_440_000, 1, 1),
    ("speed 1/4, output at the 60 s cap", 720_000, 1, 4),
    (
        "speed 1/2, cut cap, output at the 60 s cap",
        1_440_000,
        1,
        2,
    ),
    ("speed 4, cut cap", 1_440_000, 4, 1),
    ("speed 1/4, the old 10 s cut cap", 480_000, 1, 4),
    ("speed 4, renderer input ceiling", 1 << 21, 4, 1),
];

/// The LCG noise used by the vectors.
#[must_use]
pub fn noise(len: usize) -> Vec<i16> {
    let mut state = 12345u32;
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 16) as u16 as i16
        })
        .collect()
}

/// Runs every case: one warm-up render, then `runs` timed renders.
///
/// # Errors
/// A message if any render fails.
pub fn run(host: &RenderHost, runs: usize) -> Result<Vec<CaseResult>, String> {
    CASES
        .iter()
        .map(|&(name, len, p, q)| {
            let input = noise(len);
            let ratio = Ratio { p, q };
            host.render(&input, ratio, Method::Hermite)
                .map_err(|e| format!("{name}: {e}"))?;
            let mut times = Vec::with_capacity(runs);
            let mut last = None;
            for _ in 0..runs.max(1) {
                let started = Instant::now();
                let (out, stats) = host
                    .render_with_stats(&input, ratio, Method::Hermite)
                    .map_err(|e| format!("{name}: {e}"))?;
                times.push(started.elapsed());
                last = Some((out.len(), stats));
            }
            times.sort();
            let (output_frames, stats) = last.ok_or("no renders ran")?;
            Ok(CaseResult {
                name,
                input_frames: len,
                output_frames,
                median: times[times.len() / 2],
                slowest: times[times.len() - 1],
                fuel: stats.fuel_used,
                memory_bytes: stats.peak_memory_bytes,
            })
        })
        .collect()
}

/// The process's resident-memory high-water mark from `/proc/self/status`, in kB, where it exists.
#[must_use]
pub fn peak_rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}
