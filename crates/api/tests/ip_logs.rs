#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Privacy of the per-visitor limits: no address reaches a stored row, a log line or a metric.
//!
//! This is the only test in its binary on purpose. A thread-local `tracing` subscriber installed
//! with `set_default` can lose events when other tests run in parallel in the same process, because
//! callsite registration is global; with one test there is nothing to race with.

mod common;

use common::Harness;
use serde_json::json;
use std::io::Write;
use std::sync::{Arc, Mutex};

const SECRET: &str = "an-operator-secret-0123456789";
const ADMIN: &str = "x-graft-admin-secret";

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

/// A limit uses an address for one window, in memory. No row, log line or metric ever holds it,
/// including the entries a visitor wrote into a forwarding header.
#[tokio::test]
async fn no_address_appears_in_any_stored_row_log_line_or_metric() {
    let h = Harness::configured(|c| {
        c.admin_secret = Some(SECRET.to_owned());
        c.guardrails.publish_per_ip.count = 1;
        c.guardrails.report_per_ip.count = 1;
        c.guardrails.admin_failures_per_ip.count = 1;
    })
    .await;
    let parent = match h.seed("seed:door", 0).await {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    };
    let capture = Capture::default();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .json()
            .with_writer(capture.clone())
            .finish(),
    );
    let spoof = [("x-forwarded-for", "198.51.100.99")];
    // Every path that touches an address: admitted, refused, reported, and a failed admin attempt.
    for n in 0..2 {
        h.send_from(
            "203.0.113.77",
            "POST",
            "/v1/publications",
            &spoof,
            Some(&json!({
                "parent_id": parent,
                "cut": { "start": 0, "end": 24_000 },
                "speed": { "p": 3, "q": 2 },
                "title": "slower",
                "author": "jo",
                "retry_key": format!("retry-key-for-test-{:04}", 400 + n),
            })),
        )
        .await;
        h.send_from(
            "203.0.113.77",
            "POST",
            "/v1/reports",
            &spoof,
            Some(&json!({ "publication_id": parent, "category": "spam" })),
        )
        .await;
        h.send_from(
            "203.0.113.77",
            "GET",
            "/admin/reports",
            &[
                ("x-forwarded-for", "198.51.100.99"),
                (ADMIN, "wrong-wrong-wrong-wrong-wrong"),
            ],
            None,
        )
        .await;
    }
    let metrics = h.scrape().await;
    let logs = String::from_utf8(capture.0.lock().expect("lock").clone()).expect("utf-8");
    assert!(
        logs.contains("request finished"),
        "the capture saw the requests: {logs}"
    );
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.tables WHERE table_schema = 'public'",
    )
    .fetch_all(h.db.store.pool())
    .await
    .expect("tables");
    let mut rows = String::new();
    for table in &tables {
        let dumped: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT t::text FROM \"{table}\" t"
        )))
        .fetch_all(h.db.store.pool())
        .await
        .expect("rows");
        rows.push_str(&dumped.join("\n"));
    }
    assert!(!tables.is_empty() && !rows.is_empty());
    for needle in ["203.0.113.77", "198.51.100.99", "203.0.113", "198.51.100"] {
        assert!(!metrics.contains(needle), "{needle} is in the metrics");
        assert!(!logs.contains(needle), "{needle} is in a log line");
        assert!(!rows.contains(needle), "{needle} is in a stored row");
    }
    assert!(
        metrics.contains("graft_refusals_total{reason=\"rate_limited_publish\"}"),
        "the refusals were counted, by reason only: {metrics}"
    );
    h.finish().await;
}
