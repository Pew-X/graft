#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The whole path with the real object store: publish through the HTTP API, read the chain, fetch
//! the audio from the signed URL the way a browser would (no credentials, straight from the object
//! store), and check it is exactly the independent reference render.
//!
//! Needs an S3-compatible server at `GRAFT_TEST_S3_ENDPOINT` (default `http://127.0.0.1:59000`)
//! with the bucket `graft-test`; see `README.md`.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use graft_api::config::Config;
use graft_api::http::{AppState, router};
use graft_api::seed::{SeedSource, seed_source};
use graft_domain::chain::SourceEvidence;
use graft_domain::hash::Sha256Hash;
use graft_storage::testing::TestDb;
use graft_storage::{BlobStore, S3BlobStore, S3Config};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

/// SHA-256 of the independent Python reference render of the harness audio, cut 1000..24000 at
/// 3/2 (see `publish.rs`); 15,333 frames.
const FLIP_3_2_HASH: &str = "204c12e72a7515329eda288d29d4f3ea2cbe1e8db9aeb082cf109b6043447f8f";

fn s3_config(prefix: &str) -> S3Config {
    let endpoint =
        std::env::var("GRAFT_TEST_S3_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:59000".into());
    let mut c = S3Config::new(
        Some(endpoint),
        "graft-test",
        "us-east-1",
        "graftaccess",
        "graftsecret12345",
    );
    c.allow_http = true;
    c.prefix = Some(prefix.to_owned());
    c
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<&Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    let payload = match body {
        Some(json) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(json.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(builder.body(payload).expect("request"))
        .await
        .expect("response");
    let (parts, body) = response.into_parts();
    let bytes = body.collect().await.expect("body").to_bytes();
    (
        parts.status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn http_get(url: &str) -> (u16, Vec<u8>) {
    let rest = url.strip_prefix("http://").expect("an http URL");
    let (host, path) = rest.split_once('/').expect("a path");
    let mut stream = tokio::net::TcpStream::connect(host).await.expect("connect");
    stream
        .write_all(
            format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await
        .expect("write");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("headers");
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status");
    let mut body = raw[split + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") {
        let mut data = body.as_slice();
        let mut out = Vec::new();
        loop {
            let eol = data
                .windows(2)
                .position(|w| w == b"\r\n")
                .expect("size line");
            let size =
                usize::from_str_radix(std::str::from_utf8(&data[..eol]).expect("utf-8").trim(), 16)
                    .expect("hex");
            data = &data[eol + 2..];
            if size == 0 {
                break;
            }
            out.extend_from_slice(&data[..size]);
            data = &data[size + 2..];
        }
        body = out;
    }
    (status, body)
}

#[tokio::test]
async fn audio_published_through_the_api_is_served_from_a_signed_url_and_equals_the_reference_render()
 {
    let db = TestDb::create().await;
    let prefix = format!(
        "e2e-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    );
    let blobs: Arc<dyn BlobStore> =
        Arc::new(S3BlobStore::new(&s3_config(&prefix)).expect("client"));
    let mut config = Config::from_lookup(|n| (n == "GRAFT_DATABASE_URL").then(|| db.url.clone()))
        .expect("config");
    config.blob_url_ttl_secs = 2; // short on purpose: this test watches a URL expire
    let state = AppState::new(&config, db.store.clone(), blobs.clone(), common::host());
    let app = router(state, &config);

    let parent = match seed_source(
        &db.store,
        blobs.as_ref(),
        &config.limits,
        SeedSource {
            key: "seed:door".into(),
            title: "a door".into(),
            author: "pat".into(),
            evidence: SourceEvidence {
                licence: "own recording".into(),
                work_title: None,
                work_author: None,
                url: None,
            },
            audio: common::audio(0),
            renderer: common::renderer(),
        },
    )
    .await
    .expect("seed")
    {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    };

    let publish = json!({
        "parent_id": parent,
        "cut": { "start": 1000, "end": 24_000 },
        "speed": { "p": 3, "q": 2 },
        "title": "slower",
        "author": "jo",
        "retry_key": "s3-end-to-end-retry-key-0001",
    });
    let (status, published) = call(&app, "POST", "/v1/publications", Some(&publish)).await;
    assert_eq!(status, StatusCode::CREATED, "{published}");
    assert_eq!(
        published["publication"]["details"]["output_blob"],
        FLIP_3_2_HASH
    );
    let id = published["publication"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let manage_key = published["manage_key"].as_str().expect("key").to_owned();

    // Read the chain and fetch the flip's audio from the URL it carries.
    let (_, chain) = call(&app, "GET", &format!("/v1/chains/{id}"), None).await;
    let url = chain["stages"][1]["audio"]["url"]
        .as_str()
        .expect("a signed URL")
        .to_owned();
    assert!(
        url.starts_with("http://127.0.0.1:59000/") || url.contains("graft-test"),
        "the URL points at the object store, not at this service: {url}"
    );
    assert!(!url.contains("graftsecret12345"), "no secret in a URL");
    let (code, audio) = http_get(&url).await;
    assert_eq!(code, 200);
    assert_eq!(audio.len(), 15_333 * 2);
    assert_eq!(
        Sha256Hash::of(&audio).to_hex(),
        FLIP_3_2_HASH,
        "the audio the listener fetches is the reference render"
    );

    // Withdraw it: new reads issue no URL for it...
    let withdraw = Request::builder()
        .method("POST")
        .uri(format!("/v1/publications/{id}/withdraw"))
        .header("x-graft-manage-key", &manage_key)
        .body(Body::empty())
        .expect("request");
    assert_eq!(
        app.clone()
            .oneshot(withdraw)
            .await
            .expect("response")
            .status(),
        StatusCode::OK
    );
    let (_, after) = call(&app, "GET", &format!("/v1/chains/{id}"), None).await;
    assert_eq!(after["stages"][1]["state"], "no_longer_here");
    assert!(after["stages"][1].get("audio").is_none());

    // ...but a URL already issued works until its short lifetime ends, and then it does not. That is
    // exactly what a takedown achieves, and the documentation says so.
    let (still, _) = http_get(&url).await;
    assert_eq!(still, 200, "an issued URL is not recalled; it expires");
    tokio::time::sleep(Duration::from_secs(3)).await;
    let (expired, _) = http_get(&url).await;
    assert_ne!(
        expired, 200,
        "and it stops working after its lifetime (got {expired})"
    );
    db.drop_db().await;
}
