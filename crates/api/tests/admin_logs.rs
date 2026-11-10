#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The operator secret and the reporter's note never reach the logs.
//!
//! This is the only test in its binary on purpose: a thread-local `tracing` subscriber installed
//! with `set_default` can lose events when other tests run in parallel in the same process,
//! because callsite registration is global; with one test there is nothing to race with.

mod common;

use common::Harness;
use serde_json::json;
use std::io::Write;
use std::sync::{Arc, Mutex};

const SECRET: &str = "operator-secret-for-tests-0123456789";

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
async fn logs_never_contain_the_operator_secret_or_a_reporters_note() {
    let h = Harness::configured(|c| c.admin_secret = Some(SECRET.to_owned())).await;
    let id = match h.seed("seed:door", 0).await {
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
    let wrong = "w".repeat(30);
    let note = "a private note that must stay out of the logs";
    h.post(
        "/v1/reports",
        &json!({ "publication_id": id, "category": "other", "note": note }),
    )
    .await;
    h.send(
        "GET",
        "/admin/reports",
        &[("x-graft-admin-secret", SECRET)],
        None,
    )
    .await;
    h.send(
        "GET",
        "/admin/reports",
        &[("x-graft-admin-secret", &wrong)],
        None,
    )
    .await;
    h.send(
        "POST",
        &format!("/admin/publications/{id}/hide"),
        &[("x-graft-admin-secret", SECRET)],
        Some(&json!({ "reason": "withdrawn" })),
    )
    .await;
    let text = String::from_utf8(capture.0.lock().expect("lock").clone()).expect("utf-8");
    assert!(text.lines().count() >= 4, "requests must be logged: {text}");
    for secret in [SECRET, wrong.as_str(), note] {
        assert!(!text.contains(secret), "{secret:?} reached the logs");
    }
    h.finish().await;
}
