#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Operational baseline: logs are JSON, carry the request id, and hold no secrets.

mod common;

use common::Harness;
use std::io::Write;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("lock").extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[tokio::test]
async fn every_request_log_line_is_json_with_the_request_id_and_no_connection_string() {
    let h = Harness::new().await;
    let capture = Capture::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_writer(capture.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let request = axum::http::Request::builder()
        .uri("/v1/chains/not-an-id")
        .body(axum::body::Body::empty())
        .expect("request");
    let response = tower::ServiceExt::oneshot(h.app.clone(), request)
        .await
        .expect("response");
    let header_id = response.headers()["x-request-id"]
        .to_str()
        .expect("ascii")
        .to_owned();
    let text = String::from_utf8(capture.0.lock().expect("lock").clone()).expect("utf-8");
    let lines: Vec<serde_json::Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).expect("every line is JSON"))
        .collect();
    assert!(!lines.is_empty(), "a request must be logged");
    for line in &lines {
        assert_eq!(
            line["span"]["request_id"],
            header_id.as_str(),
            "line {line} lacks the request id"
        );
    }
    assert!(
        !text.contains("postgres://"),
        "log text leaked a connection string"
    );
    h.finish().await;
}
