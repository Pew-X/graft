#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Seam 1: publishing a flip over HTTP, against a real Postgres and the real renderer. Each test
//! names the guarantee it protects.

mod common;

use axum::http::StatusCode;
use common::{Harness, is_problem};
use graft_domain::hash::Sha256Hash;
use serde_json::{Value, json};

/// SHA-256 of the render of `audio_frames(48_000, 0)[1000..24000]` at 3/2 with cubic Hermite,
/// computed by the independent Python reference (scripts/vectors/reference.py), 15,333 frames.
const FLIP_3_2_HASH: &str = "204c12e72a7515329eda288d29d4f3ea2cbe1e8db9aeb082cf109b6043447f8f";
const FLIP_3_2_FRAMES: usize = 15_333;
/// The same source cut `0..24000` at 1/2: 47,999 frames.
const FLIP_1_2_HASH: &str = "2147b2869a329489cc77327c671ad398fd093258682b4792acc97843c9cadc0a";

fn key(n: u32) -> String {
    format!("retry-key-for-test-{n:04}")
}

fn body(parent: &str, start: u32, end: u32, p: u32, q: u32, n: u32) -> Value {
    json!({
        "parent_id": parent,
        "cut": { "start": start, "end": end },
        "speed": { "p": p, "q": q },
        "title": "slower",
        "author": "jo",
        "retry_key": key(n),
    })
}

async fn source(h: &Harness) -> String {
    match h.seed("seed:door", 0).await {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    }
}

#[tokio::test]
async fn a_published_flip_ends_the_chain_and_its_audio_equals_the_independent_render() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (status, headers, res) = h
        .post("/v1/publications", &body(&parent, 1000, 24_000, 3, 2, 1))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    assert!(!is_problem(&headers));
    let stage = &res["publication"];
    assert_eq!(stage["state"], "available");
    assert_eq!(stage["kind"], "flip");
    assert_eq!(stage["parent_id"], parent.as_str());
    assert_eq!(
        stage["details"]["output_blob"], FLIP_3_2_HASH,
        "the stored output must equal the reference render"
    );
    let stored = h
        .blobs
        .get(&Sha256Hash::parse(FLIP_3_2_HASH).expect("hash"))
        .expect("audio was stored");
    assert_eq!(stored.len(), FLIP_3_2_FRAMES * 2);

    let id = stage["id"].as_str().expect("id");
    let (_, _, chain) = h.get(&format!("/v1/chains/{id}")).await;
    let stages = chain["stages"].as_array().expect("stages");
    assert_eq!(stages.len(), 2);
    assert_eq!(stages[0]["id"], parent.as_str());
    assert_eq!(stages[1]["id"], id);
    assert_eq!(
        stages[1]["details"]["speed"],
        json!({ "p": 3, "q": 2, "method": 1 })
    );
    h.finish().await;
}

#[tokio::test]
async fn a_second_speed_gives_its_own_reference_hash() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (status, _, res) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 1, 2, 1))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    assert_eq!(res["publication"]["details"]["output_blob"], FLIP_1_2_HASH);
    h.finish().await;
}

#[tokio::test]
async fn repeating_a_request_returns_the_same_publication_and_writes_nothing() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let req = body(&parent, 1000, 24_000, 3, 2, 1);
    let (s1, _, first) = h.post("/v1/publications", &req).await;
    let counts = (
        h.count("publications").await,
        h.count("content_records").await,
        h.blobs.len(),
    );
    let (s2, _, again) = h.post("/v1/publications", &req).await;
    assert_eq!((s1, s2), (StatusCode::CREATED, StatusCode::OK));
    assert_eq!(first["publication"], again["publication"]);
    assert_eq!(
        again["manage_key"],
        Value::Null,
        "a key is shown once and never again"
    );
    assert_eq!(
        counts,
        (
            h.count("publications").await,
            h.count("content_records").await,
            h.blobs.len()
        )
    );
    h.finish().await;
}

#[tokio::test]
async fn the_same_key_with_a_different_cut_or_speed_is_a_conflict_and_changes_nothing() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    h.post("/v1/publications", &body(&parent, 1000, 24_000, 3, 2, 1))
        .await;
    let before = (
        h.count("publications").await,
        h.count("content_records").await,
    );
    for changed in [
        body(&parent, 1000, 23_000, 3, 2, 1),
        body(&parent, 1000, 24_000, 2, 3, 1),
    ] {
        let (status, headers, res) = h.post("/v1/publications", &changed).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(is_problem(&headers));
        assert_eq!(res["type"], "urn:graft:problem:key-conflict");
    }
    assert_eq!(
        before,
        (
            h.count("publications").await,
            h.count("content_records").await
        )
    );
    h.finish().await;
}

#[tokio::test]
async fn two_makers_publishing_an_identical_flip_get_two_publications_and_one_audio_blob() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (_, _, a) = h
        .post("/v1/publications", &body(&parent, 1000, 24_000, 3, 2, 1))
        .await;
    let (_, _, b) = h
        .post("/v1/publications", &body(&parent, 1000, 24_000, 3, 2, 2))
        .await;
    assert_ne!(a["publication"]["id"], b["publication"]["id"]);
    assert_eq!(
        a["publication"]["details"]["output_blob"],
        b["publication"]["details"]["output_blob"]
    );
    assert_eq!(
        a["publication"]["details"]["record_id"],
        b["publication"]["details"]["record_id"]
    );
    assert_ne!(
        a["manage_key"], b["manage_key"],
        "each maker has their own key"
    );
    assert_eq!(h.count("publications").await, 3);
    assert_eq!(
        h.count("content_records").await,
        2,
        "one content record, shared"
    );
    assert_eq!(h.blobs.len(), 2, "the source audio and one flip output");
    h.finish().await;
}

/// A refusal decided before any rendering (cut and speed rules, an unknown, closed or hidden
/// parent): the status, the problem type, which field and rule, a
/// reason a person can read, and nothing written (no publication, no record, no audio).
async fn refused(
    h: &Harness,
    req: Value,
    status: StatusCode,
    kind: &str,
    field_rule: Option<(&str, &str)>,
) {
    refusal(h, req, status, kind, field_rule, false).await;
}

async fn refusal(
    h: &Harness,
    req: Value,
    status: StatusCode,
    kind: &str,
    field_rule: Option<(&str, &str)>,
    orphan_blob_allowed: bool,
) {
    let before = (
        h.count("publications").await,
        h.count("content_records").await,
        h.blobs.len(),
    );
    let (got, headers, res) = h.post("/v1/publications", &req).await;
    assert_eq!(got, status, "{req} -> {res}");
    assert!(is_problem(&headers));
    assert_eq!(res["type"], kind, "{res}");
    assert!(
        res["detail"].as_str().is_some_and(|d| d.len() > 10),
        "a reason a person can read: {res}"
    );
    if let Some((field, rule)) = field_rule {
        assert_eq!(
            (res["field"].as_str(), res["rule"].as_str()),
            (Some(field), Some(rule)),
            "{res}"
        );
    }
    let after = (
        h.count("publications").await,
        h.count("content_records").await,
        h.blobs.len(),
    );
    assert_eq!(
        (before.0, before.1),
        (after.0, after.1),
        "no rows were written: {res}"
    );
    if orphan_blob_allowed {
        assert!(after.2 <= before.2 + 1, "at most one orphan blob: {res}");
    } else {
        assert_eq!(before.2, after.2, "no audio was written: {res}");
    }
}

#[tokio::test]
async fn every_cut_and_speed_refusal_names_its_rule_and_writes_nothing() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let bad = "urn:graft:problem:invalid-field";
    let cases = [
        (body(&parent, 100, 100, 1, 1, 1), "cut", "inverted"),
        (body(&parent, 200, 100, 1, 1, 2), "cut", "inverted"),
        (body(&parent, 0, 479, 1, 1, 3), "cut", "too_short"),
        (body(&parent, 0, 480_001, 1, 1, 4), "cut", "too_long"),
        (body(&parent, 0, 48_001, 1, 1, 5), "cut", "beyond_parent"),
        (body(&parent, 0, 1000, 1, 5, 6), "speed", "out_of_range"),
        (body(&parent, 0, 1000, 5, 1, 7), "speed", "out_of_range"),
        (
            body(&parent, 0, 1000, 0, 1, 8),
            "speed",
            "term_out_of_range",
        ),
        (
            body(&parent, 0, 1000, 1, (1 << 20) + 1, 9),
            "speed",
            "term_out_of_range",
        ),
        // 480 frames at 4/1 is 120 frames of output: below the 480-frame minimum.
        (body(&parent, 0, 480, 4, 1, 10), "speed", "output_too_short"),
    ];
    for (req, field, rule) in cases {
        refused(
            &h,
            req,
            StatusCode::UNPROCESSABLE_ENTITY,
            bad,
            Some((field, rule)),
        )
        .await;
    }
    h.finish().await;
}

#[tokio::test]
async fn an_output_longer_than_twenty_seconds_is_refused() {
    let h = Harness::new().await;
    // 240,001 frames at 1/4 would be 960,001 output frames, one past the 960,000 limit.
    let parent = match h.seed_frames("seed:long", 300_000, 0).await {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    };
    refused(
        &h,
        body(&parent, 0, 240_001, 1, 4, 1),
        StatusCode::UNPROCESSABLE_ENTITY,
        "urn:graft:problem:invalid-field",
        Some(("speed", "output_too_long")),
    )
    .await;
    let (status, _, res) = h
        .post("/v1/publications", &body(&parent, 0, 240_000, 1, 4, 2))
        .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "exactly at the limit is accepted: {res}"
    );
    h.finish().await;
}

#[tokio::test]
async fn unknown_closed_or_hidden_parents_are_refused_with_their_own_problem() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let missing = "zzzzzzzzzzzz";
    refused(
        &h,
        body(missing, 0, 1000, 1, 1, 1),
        StatusCode::NOT_FOUND,
        "urn:graft:problem:not-found",
        None,
    )
    .await;
    refused(
        &h,
        body("not-an-id", 0, 1000, 1, 1, 2),
        StatusCode::NOT_FOUND,
        "urn:graft:problem:not-found",
        None,
    )
    .await;

    sqlx::query("UPDATE publications SET fork_permitted = false")
        .execute(h.db.store.pool())
        .await
        .expect("revoke");
    refused(
        &h,
        body(&parent, 0, 1000, 1, 1, 3),
        StatusCode::FORBIDDEN,
        "urn:graft:problem:fork-not-permitted",
        None,
    )
    .await;

    sqlx::query("UPDATE publications SET fork_permitted = true, hidden_reason = 'withdrawn'")
        .execute(h.db.store.pool())
        .await
        .expect("hide");
    refused(
        &h,
        body(&parent, 0, 1000, 1, 1, 4),
        StatusCode::CONFLICT,
        "urn:graft:problem:parent-unavailable",
        None,
    )
    .await;
    h.finish().await;
}

#[tokio::test]
async fn a_chain_already_at_the_depth_cap_cannot_grow() {
    let limits = graft_domain::limits::Limits {
        max_chain_depth: 2,
        ..Default::default()
    };
    let h = Harness::with_limits(limits).await;
    let parent = source(&h).await;
    let (status, _, first) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 1, 1, 1))
        .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "a chain of two is within the cap: {first}"
    );
    let child = first["publication"]["id"].as_str().expect("id").to_owned();
    refused(
        &h,
        body(&child, 0, 1000, 1, 1, 2),
        StatusCode::CONFLICT,
        "urn:graft:problem:depth-cap",
        None,
    )
    .await;
    h.finish().await;
}

#[tokio::test]
async fn the_per_stage_fork_cap_refuses_politely_and_says_when_to_try_again() {
    let h = Harness::configured(|c| c.max_forks_per_stage_per_hour = 1).await;
    let parent = source(&h).await;
    let (status, _, _) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 1, 1, 1))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, headers, res) = h
        .post("/v1/publications", &body(&parent, 0, 23_000, 1, 1, 2))
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res["type"], "urn:graft:problem:fork-cap");
    assert_eq!(res["retry_after_secs"], 600);
    assert_eq!(headers["retry-after"], "600");
    assert_eq!(
        h.count("publications").await,
        2,
        "the refused flip wrote no publication"
    );
    h.finish().await;
}

#[tokio::test]
async fn a_replay_still_answers_after_the_cap_filled_and_forking_was_closed() {
    let h = Harness::configured(|c| c.max_forks_per_stage_per_hour = 1).await;
    let parent = source(&h).await;
    let req = body(&parent, 0, 24_000, 1, 1, 1);
    let (_, _, first) = h.post("/v1/publications", &req).await;
    sqlx::query("UPDATE publications SET fork_permitted = false")
        .execute(h.db.store.pool())
        .await
        .expect("close");
    let (status, _, again) = h.post("/v1/publications", &req).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(first["publication"], again["publication"]);
    h.finish().await;
}

#[tokio::test]
async fn a_preview_mismatch_stores_the_servers_audio_says_so_and_counts_it() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let mut ok = body(&parent, 1000, 24_000, 3, 2, 1);
    ok["preview_hash"] = json!(FLIP_3_2_HASH);
    let (_, _, res) = h.post("/v1/publications", &ok).await;
    assert_eq!(res["preview_matches"], true);
    assert!(
        h.metrics
            .render()
            .contains("graft_preview_mismatch_total 0")
    );

    let mut wrong = body(&parent, 1000, 24_000, 3, 2, 2);
    wrong["preview_hash"] = json!("00".repeat(32));
    let (status, _, res) = h.post("/v1/publications", &wrong).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(res["preview_matches"], false);
    assert_eq!(
        res["publication"]["details"]["output_blob"], FLIP_3_2_HASH,
        "the server's audio, not the client's"
    );
    assert!(
        h.metrics
            .render()
            .contains("graft_preview_mismatch_total 1")
    );

    let (_, _, none) = h
        .post("/v1/publications", &body(&parent, 1000, 24_000, 3, 2, 3))
        .await;
    assert_eq!(
        none["preview_matches"],
        Value::Null,
        "no hash sent, nothing to compare"
    );
    h.finish().await;
}

#[tokio::test]
async fn public_text_is_cleaned_adjusted_fields_are_reported_and_difficult_input_is_refused() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let mut req = body(&parent, 0, 24_000, 1, 1, 1);
    req["title"] = json!("hear https://example.com now");
    req["author"] = json!("@jo   the  maker");
    let (status, _, res) = h.post("/v1/publications", &req).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    assert_eq!(res["publication"]["title"], "hear now");
    assert_eq!(
        res["publication"]["author"], "the maker",
        "the @handle token is removed; the rest is plain text"
    );
    assert_eq!(res["adjusted_fields"], json!(["title", "author"]));

    let bad = "urn:graft:problem:invalid-field";
    let unprocessable = StatusCode::UNPROCESSABLE_ENTITY;
    for (field, value, rule) in [
        ("title", "a".repeat(61), "too_long"),
        ("author", "b".repeat(33), "too_long"),
        ("title", "   ".to_owned(), "empty"),
        ("title", "\u{430}dmin".to_owned(), "mixed_scripts"), // Cyrillic а inside a Latin word
        ("author", "jo\u{200b}e".to_owned(), "character"),    // zero-width space
        ("author", "jo\u{202e}e".to_owned(), "character"),    // right-to-left override
        ("title", "line\nbreak".to_owned(), "character"),
        ("title", "x".repeat(5_000), "too_long"),
        ("author", "Admin".to_owned(), "denied_word"),
    ] {
        let mut req = body(&parent, 0, 24_000, 1, 1, 50);
        req[field] = json!(value);
        refused(&h, req, unprocessable, bad, Some((field, rule))).await;
    }
    h.finish().await;
}

#[tokio::test]
async fn malformed_oversized_and_unexpected_bodies_get_problem_details() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let mut extra = body(&parent, 0, 1000, 1, 1, 1);
    extra["admin"] = json!(true);
    let (status, headers, res) = h.post("/v1/publications", &extra).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an unknown field is refused, not ignored"
    );
    assert!(is_problem(&headers));
    assert_eq!(res["type"], "urn:graft:problem:bad-request");

    let (status, _, res) = h
        .post_raw(
            "/v1/publications",
            "{not json".to_owned(),
            "application/json",
        )
        .await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::BAD_REQUEST,
            Some("urn:graft:problem:bad-request")
        )
    );
    let (status, _, res) = h
        .post_raw("/v1/publications", "{}".to_owned(), "text/plain")
        .await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::BAD_REQUEST,
            Some("urn:graft:problem:bad-request")
        )
    );
    let huge = format!("{{\"title\":\"{}\"}}", "a".repeat(20_000));
    let (status, _, res) = h
        .post_raw("/v1/publications", huge, "application/json")
        .await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            Some("urn:graft:problem:too-large")
        )
    );

    for (field, value) in [
        ("retry_key", json!("short")),
        ("preview_hash", json!("NOTHEX")),
    ] {
        let mut req = body(&parent, 0, 1000, 1, 1, 2);
        req[field] = value;
        let (status, _, res) = h.post("/v1/publications", &req).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(res["field"], field);
    }
    h.finish().await;
}

#[tokio::test]
async fn the_manage_key_appears_in_exactly_one_response_and_only_its_hash_is_stored() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (_, _, a) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 1, 1, 1))
        .await;
    let key_a = a["manage_key"]
        .as_str()
        .expect("the creating response carries the key")
        .to_owned();
    assert_eq!(key_a.len(), 64);

    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT manage_key_hash FROM publications WHERE id = $1")
            .bind(a["publication"]["id"].as_str().expect("id"))
            .fetch_one(h.db.store.pool())
            .await
            .expect("hash");
    assert_eq!(
        stored,
        Sha256Hash::of(key_a.as_bytes()).as_bytes().to_vec(),
        "the SHA-256 of the key, not the key"
    );
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM publications WHERE encode(manage_key_hash, 'hex') = $1",
    )
    .bind(&key_a)
    .fetch_one(h.db.store.pool())
    .await
    .expect("count");
    assert_eq!(leaked, 0);

    // A replay, a second publish, and every read: none contains the first key.
    let (_, _, replay) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 1, 1, 1))
        .await;
    let (_, _, b) = h
        .post("/v1/publications", &body(&parent, 0, 23_000, 1, 1, 2))
        .await;
    let id = a["publication"]["id"].as_str().expect("id");
    let chain = h.raw(&format!("/v1/chains/{id}")).await;
    let single = h.raw(&format!("/v1/publications/{id}")).await;
    for text in [replay.to_string(), b.to_string(), chain, single] {
        assert!(!text.contains(&key_a), "the first key leaked into: {text}");
    }
    assert_ne!(a["manage_key"], b["manage_key"]);
    h.finish().await;
}
