//! Serves the start-up check result. See the library documentation for what it does and does not do.

use graft_host_check::{
    REQUEST_DEADLINE, Response, Snapshot, build_snapshot, parse_request_line, plain,
    read_first_line, route, startup_failure, unreadable,
};
use graft_vectors::table::Table;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// A request is looked at only up to its first line, and never beyond this many bytes.
const MAX_REQUEST_BYTES: usize = 8 * 1024;
/// Connections handled at once. More are refused immediately, so a flood cannot exhaust a small machine.
const MAX_IN_FLIGHT: usize = 32;
/// Time allowed to send the response to a client that reads slowly.
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
/// Time allowed for any single read; the overall limit is `REQUEST_DEADLINE`.
const READ_TIMEOUT: Duration = Duration::from_secs(1);

static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn respond(stream: &mut TcpStream, r: &Response) {
    let reason = match r.status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        414 => "URI Too Long",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let extra: String = r
        .headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n{extra}\r\n",
        r.status,
        r.content_type,
        r.body.len()
    );
    let _ = stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(r.body.as_bytes()));
}

fn handle(mut stream: TcpStream, snapshot: &Snapshot) {
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let deadline = Instant::now() + REQUEST_DEADLINE;
    let response = match read_first_line(&mut stream, MAX_REQUEST_BYTES, deadline) {
        Ok(line) => match parse_request_line(&line) {
            Some((method, path)) => route(method, path, snapshot),
            None => plain(400, "bad request\n"),
        },
        Err(error) => unreadable(&error),
    };
    respond(&mut stream, &response);
}

fn main() {
    let artefact = PathBuf::from(env_or("GRAFT_ARTEFACT", "/app/graft_render.wasm"));
    let table_path = PathBuf::from(env_or("GRAFT_TABLE", "/app/vectors.json"));
    let port = env_or("PORT", "8080");

    let start = || -> Result<Snapshot, String> {
        let wasm =
            std::fs::read(&artefact).map_err(|e| format!("cannot read the artefact: {e}"))?;
        let table =
            Table::load(&table_path).map_err(|e| format!("cannot load the vector table: {e}"))?;
        build_snapshot(&wasm, &table, &|name| std::env::var(name).ok())
    };
    // Serve a failure instead of exiting, so the platform's health check reports it.
    let snapshot = start().unwrap_or_else(|message| startup_failure(&message));

    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).unwrap_or_else(|e| {
        std::process::exit(fail(&format!("cannot listen on port {port}: {e}")));
    });
    for mut stream in listener.incoming().flatten() {
        if IN_FLIGHT.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
            let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
            respond(&mut stream, &plain(503, "busy\n"));
            continue;
        }
        let snapshot = snapshot.clone();
        std::thread::spawn(move || {
            handle(stream, &snapshot);
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

fn fail(message: &str) -> i32 {
    // Standard error is the only channel a failing start-up has.
    let _ = writeln!(std::io::stderr(), "graft-host-check: {message}");
    1
}
