//! Serves the start-up check result. See the library documentation for what it does and does not do.

use graft_fly_check::{Response, Snapshot, build_snapshot, parse_request_line, route};
use graft_vectors::table::Table;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

/// A request is read only up to its first line, and never beyond this many bytes.
const MAX_REQUEST_BYTES: usize = 8 * 1024;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn first_line(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 512];
    while buf.len() < MAX_REQUEST_BYTES && !buf.contains(&b'\n') {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let end = buf.iter().position(|b| *b == b'\n')?;
    Some(String::from_utf8_lossy(&buf[..end]).trim_end().to_string())
}

fn respond(stream: &mut TcpStream, r: &Response) {
    let reason = match r.status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        503 => "Service Unavailable",
        _ => "Bad Request",
    };
    let head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        r.status,
        r.content_type,
        r.body.len()
    );
    let _ = stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(r.body.as_bytes()));
}

fn handle(mut stream: TcpStream, snapshot: &Snapshot) {
    let response = match first_line(&mut stream)
        .as_deref()
        .and_then(parse_request_line)
    {
        Some((method, path)) => route(method, path, snapshot),
        None => Response {
            status: 400,
            content_type: "text/plain; charset=utf-8",
            body: "bad request\n".into(),
        },
    };
    respond(&mut stream, &response);
}

fn main() {
    let artefact = PathBuf::from(env_or("GRAFT_ARTEFACT", "/app/graft_render.wasm"));
    let table_path = PathBuf::from(env_or("GRAFT_TABLE", "/app/vectors.json"));
    let port = env_or("PORT", "8080");

    let started = || -> Result<Snapshot, String> {
        let wasm = std::fs::read(&artefact).map_err(|e| format!("{}: {e}", artefact.display()))?;
        let table = Table::load(&table_path).map_err(|e| e.to_string())?;
        build_snapshot(&wasm, &table, &|name| std::env::var(name).ok())
    };
    let snapshot = match started() {
        Ok(s) => s,
        Err(message) => {
            // Serve the failure instead of exiting, so the platform's health check reports it.
            let body = format!("{{\"startup_error\": {message:?}}}");
            Snapshot {
                healthy: false,
                results_json: body,
            }
        }
    };
    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).unwrap_or_else(|e| {
        std::process::exit(fail(&format!("cannot listen on port {port}: {e}")));
    });
    for stream in listener.incoming().flatten() {
        let snapshot = snapshot.clone();
        std::thread::spawn(move || handle(stream, &snapshot));
    }
}

fn fail(message: &str) -> i32 {
    // Standard error is the only channel a failing start-up has.
    let _ = writeln!(std::io::stderr(), "graft-fly-check: {message}");
    1
}
