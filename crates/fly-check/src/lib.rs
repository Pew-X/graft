//! Throwaway check service for the first deployment (ticket 03b).
//!
//! At start-up it replays the whole vector table through the render host inside the machine it runs
//! on, and records the result once. It then serves exactly two read-only routes, `/health` and
//! `/results`. It never accepts audio or any other input from the network: it looks only at the first
//! line of a request (reading at most 8 KiB, within a fixed time, and discarding the rest), and
//! nothing about a request reaches the renderer.

use graft_render_host::RenderHost;
use graft_vectors::hosted::HostedRenderer;
use graft_vectors::measure;
use graft_vectors::run::{run_canonicalisation, run_table};
use graft_vectors::table::Table;
use serde_json::{Value, json};
use std::io::Read;
use std::time::{Duration, Instant};

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
    /// Extra headers (for example `Allow` on a 405).
    pub headers: Vec<(&'static str, &'static str)>,
}

/// A plain-text response.
#[must_use]
pub fn plain(status: u16, body: &str) -> Response {
    Response {
        status,
        content_type: "text/plain; charset=utf-8",
        body: body.to_string(),
        headers: Vec::new(),
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

/// Why the first line of a request could not be read.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    /// No complete line within `max_bytes`.
    TooLong,
    /// The peer closed the connection before ending the line.
    Closed,
    /// The overall deadline passed (a client sending a byte at a time).
    TooSlow,
    /// The underlying read failed or timed out.
    Io,
}

/// Reads up to the end of the first line, never more than `max_bytes` in total and never past
/// `deadline`. Anything after the first line is not looked at.
///
/// # Errors
/// See [`ReadError`].
pub fn read_first_line<R: Read>(
    reader: &mut R,
    max_bytes: usize,
    deadline: Instant,
) -> Result<String, ReadError> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        if let Some(end) = buf.iter().position(|b| *b == b'\n') {
            return Ok(String::from_utf8_lossy(&buf[..end]).trim_end().to_string());
        }
        if buf.len() >= max_bytes {
            return Err(ReadError::TooLong);
        }
        if Instant::now() >= deadline {
            return Err(ReadError::TooSlow);
        }
        match reader.read(&mut chunk) {
            Ok(0) => return Err(ReadError::Closed),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => return Err(ReadError::Io),
        }
    }
}

/// How the service answers a request whose first line could not be read.
#[must_use]
pub fn unreadable(error: &ReadError) -> Response {
    match error {
        ReadError::TooLong => plain(414, "request line too long\n"),
        ReadError::TooSlow | ReadError::Io => plain(408, "request timeout\n"),
        ReadError::Closed => plain(400, "bad request\n"),
    }
}

/// The snapshot served when start-up failed: unhealthy, with a message that names no paths.
#[must_use]
pub fn startup_failure(message: &str) -> Snapshot {
    Snapshot {
        healthy: false,
        results_json: json!({"startup_error": message}).to_string(),
    }
}

/// How long one connection may take to deliver its first line.
pub const REQUEST_DEADLINE: Duration = Duration::from_secs(3);

/// The only routing the service has.
#[must_use]
pub fn route(method: &str, path: &str, snapshot: &Snapshot) -> Response {
    if method != "GET" {
        return Response {
            headers: vec![("Allow", "GET")],
            ..plain(405, "method not allowed\n")
        };
    }
    match path {
        "/health" if snapshot.healthy => plain(200, "ok\n"),
        "/health" => plain(503, "vector checks failing; see /results\n"),
        "/results" => Response {
            status: 200,
            content_type: "application/json",
            body: snapshot.results_json.clone(),
            headers: Vec::new(),
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
    let mut host = HostedRenderer::load(wasm).map_err(|e| format!("artefact rejected: {e}"))?;
    let cold_load = started.elapsed();
    let mut checks = run_table(table, &mut host);
    checks.extend(run_canonicalisation(table));
    let failures: Vec<Value> = checks
        .iter()
        .filter(|c| !c.passed)
        .map(|c| json!({"name": c.name, "expected": c.expected, "actual": c.actual}))
        .collect();

    let timing_host: &RenderHost = &host.0;
    let measurements: Vec<Value> = measure::run(timing_host, 15)?
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

    let identity = graft_render_host::Render::identity(timing_host);
    let doc = json!({
        "renderer": {"name": identity.name, "version": identity.version, "wasm_sha256": identity.wasm_sha256},
        "instance": {
            "fly_region": env("FLY_REGION"),
            "fly_app": env("FLY_APP_NAME"),
            "cpus": std::thread::available_parallelism().map(std::num::NonZero::get).ok(),
            "host_memory_total_kb": meminfo_total_kb(),
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
    fn a_405_names_the_method_that_is_allowed() {
        let r = route("POST", "/results", &snapshot(true));
        assert_eq!(r.headers, vec![("Allow", "GET")]);
    }

    fn far() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    #[test]
    fn only_the_first_line_is_read_and_the_rest_is_ignored() {
        let mut input: &[u8] = b"GET /health HTTP/1.1\r\nHost: x\r\n\r\nBODY THAT MUST NOT MATTER";
        assert_eq!(
            read_first_line(&mut input, 8192, far()).as_deref(),
            Ok("GET /health HTTP/1.1")
        );
    }

    #[test]
    fn a_line_past_the_cap_is_refused_not_buffered_without_bound() {
        let mut input = std::io::repeat(b'a');
        assert_eq!(
            read_first_line(&mut input, 8192, far()),
            Err(ReadError::TooLong)
        );
        assert_eq!(unreadable(&ReadError::TooLong).status, 414);
    }

    #[test]
    fn a_connection_that_closes_mid_line_is_a_bad_request() {
        let mut input: &[u8] = b"GET /hea";
        assert_eq!(
            read_first_line(&mut input, 8192, far()),
            Err(ReadError::Closed)
        );
        assert_eq!(unreadable(&ReadError::Closed).status, 400);
    }

    #[test]
    fn a_client_dripping_one_byte_at_a_time_is_cut_off_by_the_overall_deadline() {
        struct Drip;
        impl Read for Drip {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(30));
                buf[0] = b'a';
                Ok(1)
            }
        }
        let started = Instant::now();
        let deadline = started + Duration::from_millis(200);
        assert_eq!(
            read_first_line(&mut Drip, 8192, deadline),
            Err(ReadError::TooSlow)
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(unreadable(&ReadError::TooSlow).status, 408);
    }

    #[test]
    fn non_utf8_input_is_decoded_lossily_and_ends_in_a_clean_refusal() {
        let mut input: &[u8] = b"\xff\xfe GET\n";
        let line = read_first_line(&mut input, 8192, far()).expect("a line");
        assert_eq!(parse_request_line(&line), None);
    }

    #[test]
    fn a_startup_failure_is_unhealthy_valid_json_and_names_no_paths() {
        let snap = startup_failure("artefact rejected: bad \u{1b}[31m bytes \"quoted\"");
        assert!(!snap.healthy);
        let doc: serde_json::Value = serde_json::from_str(&snap.results_json).expect("valid JSON");
        assert!(
            doc["startup_error"]
                .as_str()
                .expect("string")
                .contains("quoted")
        );
        assert_eq!(route("GET", "/health", &snap).status, 503);
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
