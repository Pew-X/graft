//! Throwaway check service for the first deployment (ticket 03b).
//!
//! At start-up it replays the whole vector table through the render host inside the machine it runs
//! on, and records the result once. It then serves exactly two read-only routes, `/health` and
//! `/results`. It never accepts audio or any other input from the network: a request is read only as
//! far as its first line, and nothing about a request reaches the renderer.

use graft_render_host::{Limits, RenderHost};
use graft_vectors::hosted::HostedRenderer;
use graft_vectors::measure;
use graft_vectors::run::{run_canonicalisation, run_table};
use graft_vectors::table::Table;
use serde_json::{Value, json};
use std::time::Instant;

/// What the service knows after its start-up run; computed once and never changed.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// True when every check passed.
    pub healthy: bool,
    /// The read-only results document.
    pub results_json: String,
}

/// An HTTP response in its simplest form.
#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    /// Status code.
    pub status: u16,
    /// Content type header value.
    pub content_type: &'static str,
    /// Body.
    pub body: String,
}

fn plain(status: u16, body: &str) -> Response {
    Response {
        status,
        content_type: "text/plain; charset=utf-8",
        body: body.to_string(),
    }
}

/// Splits a request line into method and path (the query string is dropped).
#[must_use]
pub fn parse_request_line(line: &str) -> Option<(&str, &str)> {
    let mut parts = line.split_whitespace();
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if !version.starts_with("HTTP/") || parts.next().is_some() {
        return None;
    }
    Some((method, target.split('?').next().unwrap_or(target)))
}

/// The only routing the service has.
#[must_use]
pub fn route(method: &str, path: &str, snapshot: &Snapshot) -> Response {
    if method != "GET" {
        return plain(405, "method not allowed\n");
    }
    match path {
        "/health" if snapshot.healthy => plain(200, "ok\n"),
        "/health" => plain(503, "vector checks failing; see /results\n"),
        "/results" => Response {
            status: 200,
            content_type: "application/json",
            body: snapshot.results_json.clone(),
        },
        _ => plain(404, "not found\n"),
    }
}

/// Runs the table and the worst-case measurements against `wasm` and builds the snapshot.
///
/// `env` supplies the platform's environment (Fly sets region and app name); it is a parameter so
/// tests do not read the process environment.
///
/// # Errors
/// A message when the artefact fails to load (including a pin mismatch) or a measurement render fails.
pub fn build_snapshot(
    wasm: &[u8],
    table: &Table,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Snapshot, String> {
    let started = Instant::now();
    let host = HostedRenderer::load(wasm).map_err(|e| format!("artefact rejected: {e}"))?;
    let cold_load = started.elapsed();
    let mut host = host;
    let mut checks = run_table(table, &mut host);
    checks.extend(run_canonicalisation(table));
    let failures: Vec<Value> = checks
        .iter()
        .filter(|c| !c.passed)
        .map(|c| json!({"name": c.name, "expected": c.expected, "actual": c.actual}))
        .collect();

    // A second host, loaded the same way, for the timing runs (the table host is not reused so its
    // instance count does not matter).
    let timing_host = RenderHost::load(wasm, Limits::default()).map_err(|e| e.to_string())?;
    let measurements: Vec<Value> = measure::run(&timing_host, 15)?
        .into_iter()
        .map(|c| {
            json!({
                "case": c.name,
                "input_frames": c.input_frames,
                "output_frames": c.output_frames,
                "median_ms": c.median.as_secs_f64() * 1000.0,
                "slowest_ms": c.slowest.as_secs_f64() * 1000.0,
                "fuel": c.fuel,
                "linear_memory_bytes": c.memory_bytes,
            })
        })
        .collect();

    let identity = graft_render_host::Render::identity(&timing_host);
    let doc = json!({
        "renderer": {"name": identity.name, "version": identity.version, "wasm_sha256": identity.wasm_sha256},
        "instance": {
            "fly_region": env("FLY_REGION"),
            "fly_app": env("FLY_APP_NAME"),
            "cpus": std::thread::available_parallelism().map(std::num::NonZero::get).ok(),
            "memory_total_kb": meminfo_total_kb(),
        },
        "cold_start_ms": {"load_and_compile_and_pin_check": cold_load.as_secs_f64() * 1000.0},
        "checks": {"total": checks.len(), "passed": checks.len() - failures.len(), "failed": failures.len(), "failures": failures},
        "measurements": measurements,
        "process_peak_rss_kb": measure::peak_rss_kb(),
    });
    Ok(Snapshot {
        healthy: doc["checks"]["failed"] == 0,
        results_json: serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
    })
}

fn meminfo_total_kb() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    text.lines()
        .find(|l| l.starts_with("MemTotal"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(healthy: bool) -> Snapshot {
        Snapshot {
            healthy,
            results_json: "{\"checks\":{}}".into(),
        }
    }

    #[test]
    fn health_reports_the_vector_result_not_just_liveness() {
        assert_eq!(route("GET", "/health", &snapshot(true)).status, 200);
        assert_eq!(route("GET", "/health", &snapshot(false)).status, 503);
    }

    #[test]
    fn results_are_served_read_only_as_json() {
        let r = route("GET", "/results", &snapshot(true));
        assert_eq!((r.status, r.content_type), (200, "application/json"));
        assert_eq!(r.body, "{\"checks\":{}}");
    }

    #[test]
    fn nothing_but_get_is_accepted_and_unknown_paths_are_not_found() {
        for method in ["POST", "PUT", "DELETE", "PATCH", "HEAD"] {
            assert_eq!(
                route(method, "/results", &snapshot(true)).status,
                405,
                "{method}"
            );
        }
        assert_eq!(route("GET", "/render", &snapshot(true)).status, 404);
        assert_eq!(route("GET", "/", &snapshot(true)).status, 404);
    }

    #[test]
    fn request_lines_parse_and_drop_the_query_string() {
        assert_eq!(
            parse_request_line("GET /health?x=1 HTTP/1.1"),
            Some(("GET", "/health"))
        );
        assert_eq!(
            parse_request_line("GET /results HTTP/1.0"),
            Some(("GET", "/results"))
        );
        assert_eq!(parse_request_line("garbage"), None);
        assert_eq!(parse_request_line("GET /a HTTP/1.1 extra"), None);
        assert_eq!(parse_request_line("GET /a FTP/1.1"), None);
    }
}
