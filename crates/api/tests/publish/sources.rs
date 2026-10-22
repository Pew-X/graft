//! Publishing a source over HTTP, against a real Postgres: switched off by default, validated
//! before anything is stored, declared and never established. Each test names the guarantee it
//! protects.

use super::common::{Harness, audio_frames, is_problem};
use super::{body, source};
use axum::http::StatusCode;
use base64::Engine;
use graft_api::source::DECLARATION_TEXT;
use graft_domain::hash::Sha256Hash;
use serde_json::{Value, json};

const SECRET: &str = "an-operator-secret-0123456789";

async fn open() -> Harness {
    Harness::configured(|c| {
        c.admin_secret = Some(SECRET.to_owned());
        c.guardrails.uploads_enabled = true;
    })
    .await
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn upload(audio: &[u8], n: u32) -> Value {
    json!({
        "audio": b64(audio),
        "title": "my door",
        "author": "pat",
        "retry_key": format!("source-retry-key-{n:04}"),
        "declaration": { "statement": DECLARATION_TEXT, "basis": "own_recording" },
    })
}

async fn send(h: &Harness, payload: &Value) -> (StatusCode, axum::http::HeaderMap, Value) {
    h.send_from("203.0.113.20", "POST", "/v1/sources", &[], Some(payload))
        .await
}

async fn nothing_stored(h: &Harness, before: (i64, i64, usize), what: &str) {
    assert_eq!(
        (
            h.count("publications").await,
            h.count("events").await,
            h.blobs.len()
        ),
        before,
        "{what}: no row, event or blob was written"
    );
}

async fn state_of(h: &Harness) -> (i64, i64, usize) {
    (
        h.count("publications").await,
        h.count("events").await,
        h.blobs.len(),
    )
}

#[tokio::test]
async fn with_uploads_off_the_route_refuses_kindly_writes_nothing_and_flips_still_work() {
    let h = Harness::configured(|c| c.admin_secret = Some(SECRET.to_owned())).await;
    let parent = source(&h).await;
    let before = state_of(&h).await;
    let (status, headers, res) = send(&h, &upload(&audio_frames(24_000, 3), 1)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{res}");
    assert!(is_problem(&headers));
    assert_eq!(res["type"], "urn:graft:problem:uploads-off");
    assert!(
        res["detail"]
            .as_str()
            .is_some_and(|d| d.contains("switched off")),
        "{res}"
    );
    nothing_stored(&h, before, "a refused upload").await;
    // Flipping an existing sound is independent of the uploads switch.
    let (status, _, res) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 3, 2, 1))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    h.finish().await;
}

#[tokio::test]
async fn a_valid_upload_makes_one_root_publication_with_its_declaration_shown_as_declared() {
    let h = open().await;
    let audio = audio_frames(24_000, 5);
    let (status, _, res) = send(&h, &upload(&audio, 2)).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let stage = &res["publication"];
    assert_eq!(stage["state"], "available");
    assert_eq!(stage["kind"], "source");
    assert!(stage["parent_id"].is_null());
    assert_eq!(
        stage["details"]["output_blob"],
        Sha256Hash::of(&audio).to_hex().as_str(),
        "the output is the submitted audio, byte for byte"
    );
    assert_eq!(
        stage["details"]["output_blob"],
        stage["details"]["source_blob"]
    );
    assert!(
        stage["details"]["declared_at_ms"]
            .as_i64()
            .is_some_and(|t| t > 0)
    );
    let line = |role: &str| {
        stage["lines"]
            .as_array()
            .expect("lines")
            .iter()
            .find(|l| l["role"] == role)
            .unwrap_or_else(|| panic!("no {role} line in {stage}"))
            .clone()
    };
    assert_eq!(line("declaration")["value"], DECLARATION_TEXT);
    assert_eq!(line("declaration")["honesty"], "declared");
    assert_eq!(line("licence")["value"], "own recording");
    assert_eq!(line("licence")["honesty"], "declared");
    assert_eq!(line("rights")["honesty"], "unknown", "rights stay unknown");
    assert!(res["manage_key"].as_str().is_some_and(|k| k.len() == 64));
    // One publication event, of kind source.
    let events: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT kind, detail FROM events ORDER BY seq")
            .fetch_all(h.db.store.pool())
            .await
            .expect("events");
    assert_eq!(
        events,
        [("publication_created".to_owned(), Some("source".to_owned()))]
    );
    // The words that would claim more than was declared appear nowhere in the response.
    let text = res.to_string().to_lowercase();
    for banned in ["verified", "proven", "certified", "owned by", "cleared"] {
        assert!(!text.contains(banned), "{banned} in {text}");
    }
    h.finish().await;
}

#[tokio::test]
async fn the_same_key_returns_the_same_publication_and_a_different_sound_under_it_conflicts() {
    let h = open().await;
    let first = upload(&audio_frames(24_000, 1), 3);
    let (status, _, created) = send(&h, &first).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let before = state_of(&h).await;
    let (status, _, again) = send(&h, &first).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["publication"]["id"], created["publication"]["id"]);
    assert!(again["manage_key"].is_null(), "the key is shown once");
    nothing_stored(&h, before, "a replay").await;
    let other = upload(&audio_frames(24_000, 2), 3);
    let (status, _, res) = send(&h, &other).await;
    assert_eq!(status, StatusCode::CONFLICT, "{res}");
    assert_eq!(res["type"], "urn:graft:problem:key-conflict");
    assert_eq!(h.count("publications").await, 1);
    h.finish().await;
}

#[tokio::test]
async fn every_validation_refusal_names_its_rule_and_stores_neither_a_blob_nor_a_row() {
    let h = open().await;
    let limits = h.limits.clone();
    let loud = audio_frames(24_000, 0);
    let mut odd = loud.clone();
    odd.push(0);
    let too_short = audio_frames(limits.min_frames as i32 - 1, 0);
    let too_long = audio_frames(limits.max_source_frames as i32 + 1, 0);
    let silent = vec![0u8; 48_000];
    let flat: Vec<u8> = std::iter::repeat_n(9000i16.to_le_bytes(), 24_000)
        .flatten()
        .collect();
    let clipped: Vec<u8> = (0..24_000)
        .flat_map(|i| (if i % 2 == 0 { 32_767i16 } else { -32_768 }).to_le_bytes())
        .collect();

    let mut no_declaration = upload(&loud, 10);
    no_declaration
        .as_object_mut()
        .expect("object")
        .remove("declaration");
    let mut altered = upload(&loud, 11);
    altered["declaration"]["statement"] = json!("I agree");
    let mut bad_basis = upload(&loud, 12);
    bad_basis["declaration"]["basis"] = json!("found it");
    let mut bad_text = upload(&loud, 13);
    bad_text["title"] = json!("   ");
    let mut bad_author = upload(&loud, 14);
    bad_author["author"] = json!("pat @someone https://example.com");
    let mut only_a_handle = upload(&loud, 17);
    only_a_handle["author"] = json!("@someone");
    let mut bad_key = upload(&loud, 15);
    bad_key["retry_key"] = json!("short");
    let mut bad_encoding = upload(&loud, 16);
    bad_encoding["audio"] = json!("not base64 !!!");

    let cases: Vec<(&str, Value, &str, &str)> = vec![
        ("too long", upload(&too_long, 1), "audio", "too_long"),
        ("too short", upload(&too_short, 2), "audio", "too_short"),
        ("odd length", upload(&odd, 3), "audio", "odd_length"),
        ("silence", upload(&silent, 4), "audio", "silent"),
        ("a flat line", upload(&flat, 5), "audio", "constant"),
        ("clipping noise", upload(&clipped, 6), "audio", "clipped"),
        ("no declaration", no_declaration, "declaration", "required"),
        ("an altered statement", altered, "declaration", "statement"),
        ("an unknown basis", bad_basis, "declaration", "basis"),
        ("an empty title", bad_text, "title", "empty"),
        (
            "a name that is only a handle",
            only_a_handle,
            "author",
            "empty",
        ),
        ("a handle and a link in the name", bad_author, "author", ""),
        ("a short retry key", bad_key, "retry_key", "format"),
        ("bad base64", bad_encoding, "audio", "encoding"),
    ];
    for (what, payload, field, rule) in cases {
        let before = state_of(&h).await;
        let (status, headers, res) = send(&h, &payload).await;
        // A handle and a link are removed rather than refused: that case is stored and reported.
        if what == "a handle and a link in the name" {
            assert_eq!(status, StatusCode::CREATED, "{what}: {res}");
            assert_eq!(res["adjusted_fields"], json!(["author"]));
            continue;
        }
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{what}: {res}");
        assert!(is_problem(&headers), "{what}");
        assert_eq!(
            (res["field"].as_str(), res["rule"].as_str()),
            (Some(field), Some(rule)),
            "{what}: {res}"
        );
        assert!(
            res["detail"].as_str().is_some_and(|d| d.len() > 10),
            "{what}: a reason a person can read: {res}"
        );
        nothing_stored(&h, before, what).await;
    }
    h.finish().await;
}

#[tokio::test]
async fn a_forged_oversized_body_is_cut_off_at_the_limit_not_read_in_full() {
    use axum::body::{Body, Bytes};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    let h = open().await;
    let before = state_of(&h).await;
    let pulled = Arc::new(AtomicUsize::new(0));
    let counter = pulled.clone();
    const CHUNK: usize = 64 * 1024;
    // A stream of 128 MB that counts each chunk as it is produced: lazily, so only what the
    // service actually reads is ever made.
    let stream = futures::stream::iter((0..2000).map(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
        Ok::<_, std::convert::Infallible>(Bytes::from(vec![b'A'; CHUNK]))
    }));
    let mut request = axum::http::Request::builder()
        .method("POST")
        .uri("/v1/sources")
        .header("content-type", "application/json")
        .body(Body::from_stream(stream))
        .expect("request");
    request.extensions_mut().insert(axum::extract::ConnectInfo(
        "203.0.113.30:40000"
            .parse::<std::net::SocketAddr>()
            .expect("addr"),
    ));
    let started = std::time::Instant::now();
    let response = h.app.clone().oneshot(request).await.expect("response");
    let took = started.elapsed();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let limit = graft_api::source::max_body_bytes(&h.limits);
    let read = pulled.load(Ordering::SeqCst) * CHUNK;
    assert!(
        read <= limit + 4 * CHUNK,
        "the service pulled {read} bytes for a limit of {limit}"
    );
    assert!(
        read < 128 * 1024 * 1024 / 10,
        "and nowhere near the whole body"
    );
    assert!(took < std::time::Duration::from_secs(5), "{took:?}");
    nothing_stored(&h, before, "a forged body").await;
    h.finish().await;
}

#[tokio::test]
async fn an_uploaded_source_can_be_flipped_and_appears_in_the_chain_with_its_declaration() {
    let h = open().await;
    let (_, _, created) = send(&h, &upload(&audio_frames(48_000, 7), 20)).await;
    let id = created["publication"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let (status, _, flipped) = h
        .post("/v1/publications", &body(&id, 0, 24_000, 3, 2, 21))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{flipped}");
    let leaf = flipped["publication"]["id"].as_str().expect("leaf");
    let (_, _, chain) = h
        .send("GET", &format!("/v1/chains/{leaf}"), &[], None)
        .await;
    let stages = chain["stages"].as_array().expect("stages");
    assert_eq!(stages.len(), 2);
    assert_eq!(stages[0]["id"], id.as_str());
    assert_eq!(stages[0]["flipped_count"], 1);
    let declaration = stages[0]["lines"]
        .as_array()
        .expect("lines")
        .iter()
        .find(|l| l["role"] == "declaration")
        .expect("the declaration is in the chain");
    assert_eq!(declaration["honesty"], "declared");
    h.finish().await;
}

#[tokio::test]
async fn the_kill_switch_closes_uploads_and_flips_and_the_uploads_flag_closes_only_uploads() {
    let h = open().await;
    let parent = source(&h).await;
    let set = async |on: bool| {
        let (status, _, _) = h
            .send(
                "PUT",
                "/admin/switch",
                &[("x-graft-admin-secret", SECRET)],
                Some(&json!({ "publishing": on })),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
    };
    // Kill switch closed: both refuse with the publishing message.
    set(false).await;
    let (status, _, res) = send(&h, &upload(&audio_frames(24_000, 1), 30)).await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Some("urn:graft:problem:publishing-off")
        )
    );
    let (status, _, res) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 3, 2, 31))
        .await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Some("urn:graft:problem:publishing-off")
        )
    );
    // Reopened: both work.
    set(true).await;
    assert_eq!(
        send(&h, &upload(&audio_frames(24_000, 1), 30)).await.0,
        StatusCode::CREATED
    );
    assert_eq!(
        h.post("/v1/publications", &body(&parent, 0, 24_000, 3, 2, 31))
            .await
            .0,
        StatusCode::CREATED
    );
    h.finish().await;
    // Uploads flag off, kill switch open: flips work and uploads refuse (the first test shows the
    // refusal; this shows the two switches are independent the other way round).
    let h = Harness::configured(|c| c.admin_secret = Some(SECRET.to_owned())).await;
    let parent = source(&h).await;
    assert_eq!(
        h.post("/v1/publications", &body(&parent, 0, 24_000, 3, 2, 32))
            .await
            .0,
        StatusCode::CREATED
    );
    let (status, _, res) = send(&h, &upload(&audio_frames(24_000, 1), 33)).await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Some("urn:graft:problem:uploads-off")
        )
    );
    h.finish().await;
}
