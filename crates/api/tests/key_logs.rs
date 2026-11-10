#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Operational baseline for maker actions: logs never contain key material.
//!
//! This is the only test in its binary on purpose. A thread-local `tracing` subscriber installed
//! with `set_default` can lose events when other tests run in parallel in the same process, because
//! callsite registration is global; with one test there is nothing to race with.

mod common;

use common::Harness;
use serde_json::json;
use std::io::Write;
use std::sync::{Arc, Mutex};

const KEY: &str = "x-graft-manage-key";

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
async fn logs_never_contain_key_material() {
    let h = Harness::new().await;
    let (stage, manage_key, _) = setup(&h).await;
    let capture = Capture::default();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .json()
            .with_writer(capture.clone())
            .finish(),
    );
    let wrong = "cd".repeat(32);
    withdraw(&h, &stage, &wrong).await;
    put_permission(&h, &stage, &manage_key, false).await;
    withdraw(&h, &stage, &manage_key).await;
    let text = String::from_utf8(capture.0.lock().expect("lock").clone()).expect("utf-8");
    assert!(!text.is_empty(), "requests must be logged");
    for secret in [&manage_key, &wrong] {
        assert!(!text.contains(secret.as_str()), "a key reached the logs");
    }
    h.finish().await;
}

fn flip_body(parent: &str) -> serde_json::Value {
    json!({
        "parent_id": parent,
        "cut": { "start": 0, "end": 24_000 },
        "speed": { "p": 1, "q": 1 },
        "title": "slower",
        "author": "jo",
        "retry_key": "key-logs-test-retry-key-0001",
    })
}

/// A source and a flip of it; returns the flip's id and manage key.
async fn setup(h: &Harness) -> (String, String, String) {
    let parent = match h.seed("seed:door", 0).await {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    };
    let (_, _, res) = h.post("/v1/publications", &flip_body(&parent)).await;
    (
        res["publication"]["id"].as_str().expect("id").to_owned(),
        res["manage_key"].as_str().expect("key").to_owned(),
        parent,
    )
}

async fn put_permission(h: &Harness, id: &str, key_value: &str, permitted: bool) {
    h.send(
        "PUT",
        &format!("/v1/publications/{id}/fork-permission"),
        &[(KEY, key_value)],
        Some(&json!({ "permitted": permitted })),
    )
    .await;
}

async fn withdraw(h: &Harness, id: &str, key_value: &str) {
    h.send(
        "POST",
        &format!("/v1/publications/{id}/withdraw"),
        &[(KEY, key_value)],
        None,
    )
    .await;
}
