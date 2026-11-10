#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Seam 1: a maker's note. It is optional text under the same rules as a title, the only part of a
//! publication that can change after it is published, and never part of the content record. Each
//! test names the guarantee it protects.

mod common;

use axum::http::StatusCode;
use common::{Harness, is_problem};
use serde_json::{Value, json};

const KEY: &str = "x-graft-manage-key";
const ADMIN: &str = "x-graft-admin-secret";
const SECRET: &str = "operator-secret-for-tests-0123456789";

fn flip_body(parent: &str, n: u32, note: Option<&str>) -> Value {
    let mut v = json!({
        "parent_id": parent,
        "cut": { "start": 0, "end": 24_000 },
        "speed": { "p": 1, "q": 1 },
        "title": "slower",
        "author": "jo",
        "retry_key": format!("notes-test-retry-key-{n:04}"),
    });
    if let Some(note) = note {
        v["note"] = json!(note);
    }
    v
}

async fn source(h: &Harness) -> String {
    match h.seed("seed:door", 0).await {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    }
}

async fn put_note(h: &Harness, id: &str, key: &str, body: &Value) -> (StatusCode, Value) {
    let (s, _, v) = h
        .send(
            "PUT",
            &format!("/v1/publications/{id}/note"),
            &[(KEY, key)],
            Some(body),
        )
        .await;
    (s, v)
}

async fn stage(h: &Harness, id: &str) -> Value {
    let (_, _, v) = h.get(&format!("/v1/publications/{id}")).await;
    v
}

fn note_line(v: &Value) -> Option<(String, String)> {
    v["lines"]
        .as_array()
        .and_then(|l| l.iter().find(|l| l["role"] == "note"))
        .map(|l| {
            (
                l["value"].as_str().expect("value").to_owned(),
                l["honesty"].as_str().expect("honesty").to_owned(),
            )
        })
}

async fn newest_report(h: &Harness) -> Value {
    let (_, _, v) = h
        .send("GET", "/admin/reports", &[(ADMIN, SECRET)], None)
        .await;
    v["reports"][0].clone()
}

#[tokio::test]
async fn a_note_given_at_publish_is_stored_shown_and_declared() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (status, _, res) = h
        .post(
            "/v1/publications",
            &flip_body(&parent, 1, Some("from the tape at the lake")),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let shown = &res["publication"];
    assert_eq!(shown["note"], "from the tape at the lake");
    assert_eq!(
        note_line(shown),
        Some(("from the tape at the lake".into(), "declared".into())),
        "the note is a credit line, declared and never established"
    );
    // and it reads back the same
    let id = shown["id"].as_str().expect("id");
    assert_eq!(stage(&h, id).await["note"], "from the tape at the lake");
    h.finish().await;
}

#[tokio::test]
async fn a_flip_with_no_note_or_a_blank_one_has_none_and_the_field_is_optional() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    for (n, note) in [(1, None), (2, Some("   "))] {
        let (status, _, res) = h
            .post("/v1/publications", &flip_body(&parent, n, note))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{res}");
        assert!(res["publication"]["note"].is_null());
        assert_eq!(note_line(&res["publication"]), None);
    }
    h.finish().await;
}

#[tokio::test]
async fn the_note_follows_the_title_rules_and_a_bad_one_writes_nothing() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let cases = [
        ("x".repeat(141), "too_long"),
        ("two\nlines".to_owned(), "character"),
        ("a\u{200b}b".to_owned(), "character"),
        ("p\u{0430}ypal".to_owned(), "mixed_scripts"), // a Cyrillic "a" inside a Latin word
        ("admin".to_owned(), "denied_word"),
        ("see example.com".to_owned(), ""),
    ];
    for (n, (note, rule)) in cases.iter().enumerate() {
        let before = h.count("publications").await;
        let (status, headers, res) = h
            .post(
                "/v1/publications",
                &flip_body(&parent, 10 + n as u32, Some(note)),
            )
            .await;
        if rule.is_empty() {
            // a link is removed, not refused, and the response says so
            assert_eq!(status, StatusCode::CREATED, "{res}");
            assert_eq!(res["publication"]["note"], "see");
            assert!(
                res["adjusted_fields"]
                    .as_array()
                    .expect("array")
                    .contains(&json!("note")),
                "{res}"
            );
            continue;
        }
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{note:?} {res}");
        assert!(is_problem(&headers));
        assert_eq!(
            (res["field"].as_str(), res["rule"].as_str()),
            (Some("note"), Some(*rule)),
            "{res}"
        );
        assert_eq!(h.count("publications").await, before, "nothing was written");
    }
    h.finish().await;
}

#[tokio::test]
async fn a_note_is_not_part_of_the_content_record() {
    // Two flips of the same cut and speed: one with a note, one without. The audio and the record id
    // are the same, so the note can change without touching what the record claims.
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (_, _, plain) = h
        .post("/v1/publications", &flip_body(&parent, 1, None))
        .await;
    let (_, _, noted) = h
        .post("/v1/publications", &flip_body(&parent, 2, Some("a note")))
        .await;
    assert_eq!(
        plain["publication"]["details"]["record_id"], noted["publication"]["details"]["record_id"],
        "the record id does not depend on the note"
    );
    assert_eq!(
        plain["publication"]["details"]["output_blob"],
        noted["publication"]["details"]["output_blob"]
    );
    h.finish().await;
}

#[tokio::test]
async fn the_maker_can_write_change_and_clear_the_note_and_repeating_changes_nothing() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (_, _, res) = h
        .post("/v1/publications", &flip_body(&parent, 1, None))
        .await;
    let id = res["publication"]["id"].as_str().expect("id").to_owned();
    let key = res["manage_key"].as_str().expect("key").to_owned();
    let record_id = res["publication"]["details"]["record_id"].clone();

    let (status, state) = put_note(&h, &id, &key, &json!({ "note": "first thought" })).await;
    assert_eq!(
        (status, &state),
        (
            StatusCode::OK,
            &json!({ "note": "first thought", "adjusted": false })
        )
    );
    assert_eq!(stage(&h, &id).await["note"], "first thought");
    let (_, again) = put_note(&h, &id, &key, &json!({ "note": "first thought" })).await;
    assert_eq!(again["note"], "first thought");

    let (_, state) = put_note(&h, &id, &key, &json!({ "note": "second, see example.com" })).await;
    assert_eq!(
        state,
        json!({ "note": "second, see", "adjusted": true }),
        "a link is removed and the response says so"
    );
    let shown = stage(&h, &id).await;
    assert_eq!(shown["note"], "second, see");
    assert_eq!(
        shown["details"]["record_id"], record_id,
        "the record is unchanged"
    );

    for clear in [json!({ "note": "" }), json!({ "note": null }), json!({})] {
        put_note(&h, &id, &key, &json!({ "note": "something" })).await;
        let (status, state) = put_note(&h, &id, &key, &clear).await;
        assert_eq!(
            (status, &state),
            (StatusCode::OK, &json!({ "note": null, "adjusted": false })),
            "{clear}"
        );
        assert!(stage(&h, &id).await["note"].is_null());
    }
    h.finish().await;
}

#[tokio::test]
async fn a_bad_edit_is_refused_by_rule_and_leaves_the_note_as_it_was() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (_, _, res) = h
        .post("/v1/publications", &flip_body(&parent, 1, Some("kept")))
        .await;
    let id = res["publication"]["id"].as_str().expect("id").to_owned();
    let key = res["manage_key"].as_str().expect("key").to_owned();
    let (status, bad) = put_note(&h, &id, &key, &json!({ "note": "x".repeat(141) })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    assert_eq!(bad["rule"], "too_long");
    let (status, _) = put_note(&h, &id, &key, &json!({ "note": "ok", "extra": 1 })).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unknown fields are refused"
    );
    assert_eq!(stage(&h, &id).await["note"], "kept");
    h.finish().await;
}

#[tokio::test]
async fn every_way_of_being_refused_the_note_edit_gets_the_identical_answer() {
    let h = Harness::new().await;
    let parent = source(&h).await; // seeded: it has no manage key at all
    let (_, _, res) = h
        .post("/v1/publications", &flip_body(&parent, 1, None))
        .await;
    let id = res["publication"]["id"].as_str().expect("id").to_owned();
    let key = res["manage_key"].as_str().expect("key").to_owned();
    let (_, _, other) = h
        .post("/v1/publications", &flip_body(&parent, 2, None))
        .await;
    let other_key = other["manage_key"].as_str().expect("key").to_owned();
    let body = json!({ "note": "nope" });
    let wrong = "0".repeat(64);
    let attempts = [
        put_note(&h, &id, &wrong, &body).await,
        put_note(&h, &id, &other_key, &body).await,
        put_note(&h, &id, "short", &body).await,
        put_note(&h, "zzzzzzzzzzzz", &key, &body).await,
        put_note(&h, &parent, &key, &body).await,
    ];
    for (status, problem) in &attempts {
        assert_eq!(*status, StatusCode::FORBIDDEN, "{problem}");
        assert_eq!(problem, &attempts[0].1, "the same answer for every reason");
    }
    let (status, _, _) = h
        .send(
            "PUT",
            &format!("/v1/publications/{id}/note"),
            &[],
            Some(&body),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no key at all");
    // a key in the address is refused outright
    let (status, _, _) = h
        .send(
            "PUT",
            &format!("/v1/publications/{id}/note?manage_key={key}"),
            &[(KEY, &key)],
            Some(&body),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        stage(&h, &id).await["note"].is_null(),
        "nothing was changed"
    );
    h.finish().await;
}

#[tokio::test]
async fn a_withdrawn_stage_keeps_its_note_unchanged_and_does_not_show_it() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (_, _, res) = h
        .post("/v1/publications", &flip_body(&parent, 1, Some("before")))
        .await;
    let id = res["publication"]["id"].as_str().expect("id").to_owned();
    let key = res["manage_key"].as_str().expect("key").to_owned();
    let (status, _, _) = h
        .send(
            "POST",
            &format!("/v1/publications/{id}/withdraw"),
            &[(KEY, &key)],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, problem) = put_note(&h, &id, &key, &json!({ "note": "after" })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{problem}");
    assert_eq!(problem["type"], "urn:graft:problem:note-locked");
    let (_, _, chain) = h.get(&format!("/v1/chains/{id}")).await;
    let gone = &chain["stages"][1];
    assert_eq!(gone["state"], "no_longer_here");
    assert_eq!(
        note_line(gone),
        None,
        "a stage that is not here shows no note"
    );
    h.finish().await;
}

#[tokio::test]
async fn the_operator_sees_the_note_and_when_it_last_changed_beside_each_report() {
    let h = Harness::configured(|c| c.admin_secret = Some(SECRET.to_owned())).await;
    let parent = source(&h).await;
    let (_, _, res) = h
        .post(
            "/v1/publications",
            &flip_body(&parent, 1, Some("as reported")),
        )
        .await;
    let id = res["publication"]["id"].as_str().expect("id").to_owned();
    let key = res["manage_key"].as_str().expect("key").to_owned();
    let (status, _, _) = h
        .post(
            "/v1/reports",
            &json!({ "publication_id": id, "category": "other", "note": "odd" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let first = newest_report(&h).await;
    assert_eq!(first["maker_note"], "as reported");
    assert!(first["maker_note_updated_at_ms"].is_null(), "never edited");
    put_note(&h, &id, &key, &json!({ "note": "changed after" })).await;
    let second = newest_report(&h).await;
    assert_eq!(second["maker_note"], "changed after");
    assert!(
        second["maker_note_updated_at_ms"].as_i64().expect("time")
            >= second["created_at_ms"].as_i64().expect("time"),
        "an edit after the report is visible as a later time: {second}"
    );
    h.finish().await;
}

#[tokio::test]
async fn features_say_that_notes_exist_so_a_page_never_sends_one_to_a_service_without_them() {
    let h = Harness::new().await;
    let (_, _, v) = h.get("/v1/features").await;
    assert_eq!(v["notes"], true);
    h.finish().await;
}
