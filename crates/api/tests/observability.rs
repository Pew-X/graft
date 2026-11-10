#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Traces and error tracking, end to end in one process: one publish produces the expected span
//! tree through the real exporter pipeline, a trace id sits next to the request id in the log, and
//! an error report holds none of a manage key, an operator secret, an address or a connection string.
//!
//! One test in this binary on purpose: it installs a thread-local `tracing` subscriber, and a second
//! test in the same process could race its callsite registration (see logs.rs).

mod common;

use common::Harness;
use graft_api::observability::{
    self, trace_layer, tracer_provider, tracker_layer, tracker_options,
};
use opentelemetry_sdk::trace::InMemorySpanExporter;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tracing_subscriber::layer::SubscriberExt;

const SECRET: &str = "an-operator-secret-0123456789";
const KEY: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";

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

/// What the tracker would receive, captured at its transport: the SDK's own serialisation.
#[derive(Clone, Default)]
struct Envelopes(Arc<Mutex<Vec<String>>>);

struct CaptureTransport(Envelopes);

impl sentry::Transport for CaptureTransport {
    fn send_envelope(&self, envelope: sentry::Envelope) {
        let mut bytes = Vec::new();
        envelope.to_writer(&mut bytes).expect("serialise");
        self.0
            .0
            .lock()
            .expect("lock")
            .push(String::from_utf8_lossy(&bytes).into_owned());
    }
}

impl sentry::TransportFactory for Envelopes {
    fn create_transport(&self, _: &sentry::ClientOptions) -> Arc<dyn sentry::Transport> {
        Arc::new(CaptureTransport(self.clone()))
    }
}

#[tokio::test]
async fn a_publish_makes_the_expected_span_tree_and_an_error_report_holds_nothing_personal() {
    // With nothing configured nothing is exported and nothing fails.
    let quiet = graft_api::config::Config::from_lookup(|n| {
        (n == "GRAFT_DATABASE_URL").then(|| "postgres://x".to_owned())
    })
    .expect("config");
    assert_eq!(quiet.observability.otlp_endpoint, None);
    assert_eq!(quiet.observability.error_tracker_dsn, None);
    let off = observability::init(&quiet).expect("init with nothing configured");
    assert!(!off.exporting_traces(), "no endpoint, no exporter");
    drop(off);

    let spans = InMemorySpanExporter::default();
    let provider = tracer_provider(spans.clone(), 1.0);
    let envelopes = Envelopes::default();
    let scrubber = graft_api::scrub::Scrubber::new([SECRET.to_owned()]);
    let tracker = sentry::init((
        "https://public@localhost/1",
        tracker_options("test", scrubber, Some(Arc::new(envelopes.clone()))),
    ));
    assert!(tracker.is_enabled());
    let logs = Capture::default();
    let subscriber = tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_writer(logs.clone()),
        )
        .with(trace_layer(&provider))
        .with(tracker_layer());
    let _scoped = tracing::subscriber::set_default(subscriber);

    let h = Harness::configured(|c| c.admin_secret = Some(SECRET.to_owned())).await;
    let parent = match h.seed("seed:door", 0).await {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    };

    // 1. One publish, and its span tree as exported.
    let (status, headers, res) = h
        .send_from(
            "203.0.113.55",
            "POST",
            "/v1/publications",
            &[],
            Some(&json!({
                "parent_id": parent,
                "cut": { "start": 0, "end": 24_000 },
                "speed": { "p": 3, "q": 2 },
                "title": "slower",
                "author": "jo",
                "retry_key": "retry-key-for-observability-0001",
            })),
        )
        .await;
    assert_eq!(status, 201, "{res}");
    let request_id = headers["x-request-id"].to_str().expect("ascii").to_owned();
    provider.force_flush().expect("flush");
    let finished = spans.get_finished_spans().expect("spans");
    let by_id: HashMap<_, _> = finished
        .iter()
        .map(|s| (s.span_context.span_id(), s))
        .collect();
    let root = finished
        .iter()
        .find(|s| s.name == "request" && s.parent_span_id == opentelemetry::trace::SpanId::INVALID)
        .expect("a request span");
    let descends_from = |name: &str, ancestor: &str| -> bool {
        // The seeded source made its own event.insert in another trace: look only in the request's.
        let s = finished
            .iter()
            .find(|s| s.name == name && s.span_context.trace_id() == root.span_context.trace_id())
            .unwrap_or_else(|| {
                panic!(
                    "no span named {name}; got {:?}",
                    finished.iter().map(|s| s.name.as_ref()).collect::<Vec<_>>()
                )
            });
        assert_eq!(
            s.span_context.trace_id(),
            root.span_context.trace_id(),
            "{name} is in the request's trace"
        );
        let mut at = s.parent_span_id;
        while let Some(parent) = by_id.get(&at) {
            if parent.name == ancestor {
                return true;
            }
            at = parent.parent_span_id;
        }
        false
    };
    for (name, ancestor) in [
        ("publish", "request"),
        ("render", "publish"),
        ("blob.put", "publish"),
        ("db.create_flip", "publish"),
        ("db.transaction", "db.create_flip"),
        ("event.insert", "db.transaction"),
    ] {
        assert!(
            descends_from(name, ancestor),
            "{name} should descend from {ancestor}"
        );
    }
    let render = finished
        .iter()
        .find(|s| s.name == "render")
        .expect("render");
    let attr = |key: &str| {
        render
            .attributes
            .iter()
            .find(|kv| kv.key.as_str() == key)
            .map(|kv| kv.value.to_string())
    };
    assert_eq!(
        attr("input_frames").as_deref(),
        Some("24000"),
        "the size of the input, not the audio"
    );
    assert!(
        attr("duration_us").is_some_and(|d| d.parse::<u64>().is_ok_and(|d| d > 0)),
        "its duration"
    );
    assert!(render.end_time > render.start_time);

    // The trace id sits beside the request id in the log line for that request.
    let text = String::from_utf8(logs.0.lock().expect("lock").clone()).expect("utf-8");
    let line = text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|l| {
            l["fields"]["message"] == "request finished"
                && l["span"]["request_id"] == request_id.as_str()
        })
        .expect("the request's log line");
    assert_eq!(
        line["span"]["trace_id"],
        root.span_context.trace_id().to_string().as_str(),
        "{line}"
    );

    // 2. An unexpected error, with secrets in the request. The database goes away, so the request
    // ends in a 500, and exactly that is reported.
    h.db.store.pool().close().await;
    let before = envelopes.0.lock().expect("lock").len();
    let (status, headers, _) = h
        .send_from(
            "203.0.113.55",
            "GET",
            &format!("/v1/chains/{parent}"),
            &[
                ("x-graft-manage-key", KEY),
                ("x-graft-admin-secret", SECRET),
                ("x-forwarded-for", "198.51.100.77"),
                ("user-agent", "a distinctive agent string"),
            ],
            None,
        )
        .await;
    assert_eq!(status, 500);
    let failed_request = headers["x-request-id"].to_str().expect("ascii").to_owned();
    // Text that does contain the secrets, sent through the same client: the scrubber must remove them.
    sentry::capture_message(
        &format!("boom {KEY} {SECRET} 203.0.113.9 postgres://graft:hunter2@db-internal/graft"),
        sentry::Level::Error,
    );
    let sent = envelopes.0.lock().expect("lock").clone();
    assert_eq!(sent.len(), before + 2, "the 500 and the message: {sent:#?}");
    assert!(
        sent[before].contains(&failed_request),
        "the report names the request: {}",
        sent[before]
    );
    let everything = format!(
        "{}\n{}",
        sent.join("\n"),
        String::from_utf8_lossy(&logs.0.lock().expect("lock"))
    );
    for needle in [
        KEY,
        SECRET,
        "203.0.113.55",
        "203.0.113.9",
        "198.51.100.77",
        "hunter2",
        "distinctive agent",
        "x-graft-manage-key",
        "x-graft-admin-secret",
    ] {
        assert!(
            !everything.contains(needle),
            "{needle} reached a report or a log line"
        );
    }
    // No host name, user, request data or device context rides along.
    for report in &sent {
        for field in [
            "\"request\"",
            "\"user\"",
            "\"contexts\"",
            "\"breadcrumbs\"",
            "\"server_name\"",
        ] {
            assert!(!report.contains(field), "{field} in {report}");
        }
    }
    h.finish().await;
}
