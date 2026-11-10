#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Seam 1: reports, the secret-protected admin routes, hiding with a reason, and held descendants
//! computed at read time. Each test names the guarantee it protects.

mod common;
#[path = "moderation/rollups.rs"]
mod rollups;

use axum::http::StatusCode;
use common::{Harness, is_problem};
use graft_storage::Gate;
use graft_storage::blob::BoxFuture;
use graft_storage::gate::points;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Notify;

const SECRET: &str = "operator-secret-for-tests-0123456789";
const ADMIN: &str = "x-graft-admin-secret";

fn body(parent: &str, cut_end: u32, n: u32) -> Value {
    json!({
        "parent_id": parent,
        "cut": { "start": 0, "end": cut_end },
        "speed": { "p": 1, "q": 1 },
        "title": format!("flip {n}"),
        "author": "jo",
        "retry_key": format!("moderation-test-retry-key-{n:04}"),
    })
}

async fn harness() -> Harness {
    Harness::configured(|c| c.admin_secret = Some(SECRET.to_owned())).await
}

/// A chain of four: a seeded source, then three flips, each built on the one before. Returns ids
/// from source to leaf.
async fn chain_of_four(h: &Harness) -> Vec<String> {
    let source = match h.seed("seed:door", 0).await {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    };
    let mut ids = vec![source];
    for n in 1..=3 {
        let (status, _, res) = h
            .post(
                "/v1/publications",
                &body(&ids[n - 1], 24_000 - n as u32 * 1000, n as u32),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{res}");
        ids.push(res["publication"]["id"].as_str().expect("id").to_owned());
    }
    ids
}

async fn admin(
    h: &Harness,
    method: &str,
    uri: &str,
    secret: Option<&str>,
    payload: Option<&Value>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let headers: Vec<(&str, &str)> = secret.map(|s| vec![(ADMIN, s)]).unwrap_or_default();
    h.send(method, uri, &headers, payload).await
}

async fn hide(h: &Harness, id: &str, reason: &str) -> Value {
    let (status, _, res) = admin(
        h,
        "POST",
        &format!("/admin/publications/{id}/hide"),
        Some(SECRET),
        Some(&json!({ "reason": reason })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

async fn clear(h: &Harness, id: &str) -> Value {
    let (status, _, res) = admin(
        h,
        "DELETE",
        &format!("/admin/publications/{id}/hide"),
        Some(SECRET),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

async fn states(h: &Harness, leaf: &str) -> Vec<String> {
    let (_, _, chain) = h.get(&format!("/v1/chains/{leaf}")).await;
    chain["stages"]
        .as_array()
        .expect("stages")
        .iter()
        .map(|s| s["state"].as_str().expect("state").to_owned())
        .collect()
}

#[tokio::test]
async fn a_report_is_stored_with_a_confirmation_and_holds_no_identity() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    let (status, headers, res) = h
        .post("/v1/reports", &json!({ "publication_id": ids[1], "category": "rights", "note": "this is my sound, see example.com" }))
        .await;
    assert_eq!(
        (status, &res),
        (StatusCode::CREATED, &json!({ "received": true })),
        "{headers:?}"
    );
    let (category, note): (String, Option<String>) =
        sqlx::query_as("SELECT category, note FROM reports")
            .fetch_one(h.db.store.pool())
            .await
            .expect("row");
    assert_eq!(category, "rights");
    assert_eq!(
        note.as_deref(),
        Some("this is my sound, see"),
        "links are removed from notes"
    );
    // The table has no column that could hold who filed it.
    let columns: Vec<String> = sqlx::query_scalar("SELECT column_name FROM information_schema.columns WHERE table_name = 'reports' ORDER BY column_name")
        .fetch_all(h.db.store.pool())
        .await
        .expect("columns");
    assert_eq!(
        columns,
        ["category", "created_at", "id", "note", "publication_id"],
        "no IP address, no user agent, no email"
    );
    h.finish().await;
}

#[tokio::test]
async fn report_fields_are_validated_and_nothing_is_stored_for_a_refused_one() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    let cases = [
        (
            json!({ "publication_id": ids[1], "category": "bogus" }),
            StatusCode::UNPROCESSABLE_ENTITY,
            Some(("category", "unknown")),
        ),
        (
            json!({ "publication_id": ids[1], "category": "spam", "note": "a".repeat(501) }),
            StatusCode::UNPROCESSABLE_ENTITY,
            Some(("note", "too_long")),
        ),
        (
            json!({ "publication_id": ids[1], "category": "spam", "note": "bad\nline" }),
            StatusCode::UNPROCESSABLE_ENTITY,
            Some(("note", "character")),
        ),
        (
            json!({ "publication_id": "zzzzzzzzzzzz", "category": "spam" }),
            StatusCode::NOT_FOUND,
            None,
        ),
        (
            json!({ "publication_id": "not-an-id", "category": "spam" }),
            StatusCode::NOT_FOUND,
            None,
        ),
        (
            json!({ "publication_id": ids[1], "category": "spam", "reporter": "me" }),
            StatusCode::BAD_REQUEST,
            None,
        ),
    ];
    for (req, want, field_rule) in cases {
        let (status, headers, res) = h.post("/v1/reports", &req).await;
        assert_eq!(status, want, "{req} -> {res}");
        assert!(is_problem(&headers));
        if let Some((field, rule)) = field_rule {
            assert_eq!(
                (res["field"].as_str(), res["rule"].as_str()),
                (Some(field), Some(rule))
            );
        }
    }
    assert_eq!(h.count("reports").await, 0);
    // An empty note is simply no note.
    let (status, _, _) = h
        .post(
            "/v1/reports",
            &json!({ "publication_id": ids[1], "category": "other", "note": "   " }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let note: Option<String> = sqlx::query_scalar("SELECT note FROM reports")
        .fetch_one(h.db.store.pool())
        .await
        .expect("note");
    assert_eq!(note, None);
    h.finish().await;
}

#[tokio::test]
async fn the_admin_lists_reports_newest_first_with_each_publications_current_state() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    for (i, category) in ["spam", "rights", "harmful"].iter().enumerate() {
        h.post("/v1/reports", &json!({ "publication_id": ids[i + 1], "category": category, "note": format!("note {i}") })).await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    hide(&h, &ids[2], "rights").await;
    let (status, _, res) = admin(&h, "GET", "/admin/reports", Some(SECRET), None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let reports = res["reports"].as_array().expect("reports");
    let order: Vec<&str> = reports
        .iter()
        .map(|r| r["category"].as_str().expect("category"))
        .collect();
    assert_eq!(order, ["harmful", "rights", "spam"], "newest first");
    let states: Vec<(&str, &str)> = reports
        .iter()
        .map(|r| {
            (
                r["publication_id"].as_str().expect("id"),
                r["state"].as_str().expect("state"),
            )
        })
        .collect();
    assert_eq!(
        states,
        [
            (ids[3].as_str(), "visible"),
            (ids[2].as_str(), "rights"),
            (ids[1].as_str(), "visible")
        ]
    );
    assert_eq!(reports[1]["note"], "note 1");
    let (_, _, limited) = admin(&h, "GET", "/admin/reports?limit=1", Some(SECRET), None).await;
    assert_eq!(limited["reports"].as_array().expect("reports").len(), 1);
    h.finish().await;
}

#[tokio::test]
async fn a_wrong_missing_or_unconfigured_secret_gets_the_identical_refusal_and_changes_nothing() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    let unconfigured = Harness::configured(|c| c.admin_secret = None).await; // no admin secret at all
    let wrong = "w".repeat(30);
    let mut bodies = Vec::new();
    for (harness, secret) in [
        (&h, None),
        (&h, Some("")),
        (&h, Some(wrong.as_str())),
        (&unconfigured, Some(SECRET)),
    ] {
        for (method, uri, payload) in [
            ("GET", "/admin/reports".to_owned(), None),
            (
                "POST",
                format!("/admin/publications/{}/hide", ids[1]),
                Some(json!({ "reason": "rights" })),
            ),
            (
                "DELETE",
                format!("/admin/publications/{}/hide", ids[1]),
                None,
            ),
        ] {
            let (status, headers, res) =
                admin(harness, method, &uri, secret, payload.as_ref()).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
            assert!(is_problem(&headers));
            assert_eq!(res["type"], "urn:graft:problem:admin-refused");
            assert!(!res.to_string().contains(SECRET));
            bodies.push(res);
        }
    }
    assert!(
        bodies.windows(2).all(|w| w[0] == w[1]),
        "every refusal is identical"
    );
    assert_eq!(
        states(&h, &ids[3]).await,
        ["available"; 4],
        "a refused request changed nothing"
    );
    unconfigured.finish().await;
    h.finish().await;
}

#[tokio::test]
async fn hiding_for_rights_holds_every_descendant_and_serves_no_audio_for_them() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    let (_, _, before) = h.get(&format!("/v1/chains/{}", ids[3])).await;
    let state = hide(&h, &ids[1], "rights").await;
    assert_eq!(state["hidden"], "rights");

    let (_, _, chain) = h.get(&format!("/v1/chains/{}", ids[3])).await;
    let stages = chain["stages"].as_array().expect("stages");
    assert_eq!(stages.len(), 4, "the chain is never silently shortened");
    assert_eq!(
        stages[0]["state"], "available",
        "stages above the hide are untouched"
    );
    assert_eq!(
        (stages[1]["state"].as_str(), stages[1]["reason"].as_str()),
        (Some("no_longer_here"), Some("rights"))
    );
    for held in &stages[2..] {
        assert_eq!(held["state"], "held", "built on a rights hide: held");
        assert_eq!(held["reason"], "rights");
        assert!(
            held["title"].is_string() && held["author"].is_string(),
            "the credit text is still visible"
        );
        assert!(held.get("audio").is_none(), "no audio URL for a held stage");
    }
    assert!(stages[1].get("audio").is_none());
    // Exactly one audio URL is issued in the whole chain (the source's), and none names the audio
    // of the hidden stage: new requests for hidden or held audio are refused by never issuing one.
    let hidden_blob = before["stages"][1]["details"]["output_blob"]
        .as_str()
        .expect("hash")
        .to_owned();
    let urls: Vec<&str> = stages
        .iter()
        .filter_map(|s| s["audio"]["url"].as_str())
        .collect();
    assert_eq!(
        urls.len(),
        1,
        "only the stage above the hide is audible: {urls:?}"
    );
    assert!(urls.iter().all(|u| !u.contains(&hidden_blob)), "{urls:?}");
    // The single-publication read decides the same way, from the same rule.
    let (_, _, held_single) = h.get(&format!("/v1/publications/{}", ids[3])).await;
    assert_eq!(held_single["state"], "held");

    // Clearing the hide releases everything: no job ran, and the chain reads exactly as before.
    clear(&h, &ids[1]).await;
    let (_, _, after) = h.get(&format!("/v1/chains/{}", ids[3])).await;
    assert_eq!(after, before);
    h.finish().await;
}

#[tokio::test]
async fn hiding_as_withdrawn_leaves_descendants_playable() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    hide(&h, &ids[1], "withdrawn").await;
    assert_eq!(
        states(&h, &ids[3]).await,
        ["available", "no_longer_here", "available", "available"]
    );
    let (_, _, chain) = h.get(&format!("/v1/chains/{}", ids[3])).await;
    assert!(chain["stages"][2]["audio"]["url"].is_string());
    assert!(chain["stages"][3]["audio"]["url"].is_string());
    clear(&h, &ids[1]).await;
    assert_eq!(states(&h, &ids[3]).await, ["available"; 4]);
    h.finish().await;
}

#[tokio::test]
async fn hiding_twice_is_idempotent_a_later_decision_replaces_an_earlier_one_and_unknown_ids_are_404()
 {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    let first = hide(&h, &ids[1], "rights").await;
    assert_eq!(first, hide(&h, &ids[1], "rights").await);
    assert_eq!(
        hide(&h, &ids[1], "withdrawn").await["hidden"],
        "withdrawn",
        "the operator's latest decision stands"
    );
    assert_eq!(clear(&h, &ids[1]).await, clear(&h, &ids[1]).await);
    assert_eq!(clear(&h, &ids[1]).await["hidden"], Value::Null);
    for uri in [
        "/admin/publications/zzzzzzzzzzzz/hide",
        "/admin/publications/not-an-id/hide",
    ] {
        let (status, _, _) = admin(
            &h,
            "POST",
            uri,
            Some(SECRET),
            Some(&json!({ "reason": "rights" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
    }
    let (status, _, res) = admin(
        &h,
        "POST",
        &format!("/admin/publications/{}/hide", ids[1]),
        Some(SECRET),
        Some(&json!({ "reason": "because" })),
    )
    .await;
    assert_eq!(
        (status, res["rule"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("unknown"))
    );
    h.finish().await;
}

#[tokio::test]
async fn a_held_stage_cannot_be_flipped_until_the_hide_is_cleared() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    hide(&h, &ids[1], "rights").await;
    let (status, _, res) = h.post("/v1/publications", &body(&ids[3], 5_000, 10)).await;
    assert_eq!(
        (status, res["type"].as_str()),
        (StatusCode::CONFLICT, Some("urn:graft:problem:parent-held")),
        "{res}"
    );
    let (status, _, res) = h.post("/v1/publications", &body(&ids[1], 5_000, 11)).await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::CONFLICT,
            Some("urn:graft:problem:parent-unavailable")
        ),
        "{res}"
    );
    clear(&h, &ids[1]).await;
    let (status, _, res) = h.post("/v1/publications", &body(&ids[3], 5_000, 10)).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    h.finish().await;
}

#[tokio::test]
async fn blob_identity_never_grants_access_two_publications_sharing_audio_are_decided_separately() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    // Two makers publish the identical flip of the same parent: two publications, one audio blob.
    let (_, _, a) = h.post("/v1/publications", &body(&ids[0], 12_000, 20)).await;
    let (_, _, b) = h.post("/v1/publications", &body(&ids[0], 12_000, 21)).await;
    assert_eq!(
        a["publication"]["details"]["output_blob"],
        b["publication"]["details"]["output_blob"]
    );
    let (id_a, id_b) = (
        a["publication"]["id"].as_str().expect("id"),
        b["publication"]["id"].as_str().expect("id"),
    );
    hide(&h, id_a, "rights").await;
    let (_, _, hidden) = h.get(&format!("/v1/publications/{id_a}")).await;
    let (_, _, visible) = h.get(&format!("/v1/publications/{id_b}")).await;
    assert_eq!(hidden["state"], "no_longer_here");
    assert!(hidden.get("audio").is_none());
    assert_eq!(
        visible["state"], "available",
        "the other publication of the same audio is unaffected"
    );
    assert!(visible["audio"]["url"].is_string());
    h.finish().await;
}

#[tokio::test]
async fn the_admin_routes_are_absent_from_the_public_api_document() {
    let h = harness().await;
    let (_, _, doc) = h.get("/openapi.json").await;
    let paths = doc["paths"].as_object().expect("paths");
    assert!(
        paths.keys().all(|p| !p.contains("admin")),
        "{:?}",
        paths.keys().collect::<Vec<_>>()
    );
    assert!(
        paths.contains_key("/v1/reports"),
        "reporting is public and documented"
    );
    h.finish().await;
}

/// Holds a flip at `checked` until released (once armed).
struct Hold {
    armed: Arc<AtomicBool>,
    reached: Arc<Notify>,
    release: Arc<Notify>,
}

impl Gate for Hold {
    fn reached(&self, point: &'static str) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if point == points::CHECKED && self.armed.swap(false, Ordering::SeqCst) {
                self.reached.notify_one();
                self.release.notified().await;
            }
        })
    }
}

#[tokio::test]
async fn an_operator_hide_waits_for_a_fork_in_flight_and_every_fork_after_it_is_refused() {
    let armed = Arc::new(AtomicBool::new(false));
    let (reached, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let (a, r, l) = (armed.clone(), reached.clone(), release.clone());
    let h = Harness::configured_with_gate(
        |c| c.admin_secret = Some(SECRET.to_owned()),
        move |_| {
            Arc::new(Hold {
                armed: a,
                reached: r,
                release: l,
            })
        },
    )
    .await;
    let ids = chain_of_four(&h).await;
    armed.store(true, Ordering::SeqCst);
    let fork = {
        let client = h.client();
        let req = body(&ids[1], 5_000, 30);
        tokio::spawn(async move { client.post("/v1/publications", &req).await })
    };
    tokio::time::timeout(Duration::from_secs(5), reached.notified())
        .await
        .expect("the fork reached the gate");
    let decision = {
        let client = h.client();
        let uri = format!("/admin/publications/{}/hide", ids[1]);
        tokio::spawn(async move {
            client
                .send(
                    "POST",
                    &uri,
                    &[(ADMIN, SECRET)],
                    Some(&json!({ "reason": "rights" })),
                )
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !decision.is_finished(),
        "a hide must not overtake a fork that already read the stage's flags"
    );
    release.notify_one();
    assert_eq!(fork.await.expect("fork").0, StatusCode::CREATED);
    assert_eq!(decision.await.expect("decision").0, StatusCode::OK);
    let (status, _, res) = h.post("/v1/publications", &body(&ids[1], 4_000, 31)).await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::CONFLICT,
            Some("urn:graft:problem:parent-unavailable")
        )
    );
    // The fork accepted just before the hide is held like every other descendant.
    let (_, _, chain) = h
        .get(&format!("/v1/chains/{}", fork_child(&h, &ids[1]).await))
        .await;
    assert_eq!(
        chain["stages"]
            .as_array()
            .expect("stages")
            .last()
            .expect("last")["state"],
        "held"
    );
    h.finish().await;
}

/// The id of the publication whose parent is `parent` and whose retry key ends in 0030.
async fn fork_child(h: &Harness, parent: &str) -> String {
    sqlx::query_scalar(
        "SELECT p.id FROM publications p JOIN content_records c ON c.id = p.content_id \
         WHERE c.parent_publication_id = $1 AND p.retry_key LIKE '%0030'",
    )
    .bind(parent)
    .fetch_one(h.db.store.pool())
    .await
    .expect("the fork")
}

#[tokio::test]
async fn a_replayed_publish_of_a_withdrawn_or_held_flip_gets_no_audio_url() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    // Publish a flip and keep its request, then lose access to its audio and replay the request.
    let req = body(&ids[3], 5_000, 40);
    let (status, _, first) = h.post("/v1/publications", &req).await;
    assert_eq!(status, StatusCode::CREATED, "{first}");
    assert!(first["publication"]["audio"]["url"].is_string());
    let new_id = first["publication"]["id"].as_str().expect("id").to_owned();

    hide(&h, &new_id, "withdrawn").await;
    let (status, _, again) = h.post("/v1/publications", &req).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["publication"]["state"], "no_longer_here");
    assert!(
        again["publication"].get("audio").is_none(),
        "no URL for hidden audio, even on a replay"
    );

    clear(&h, &new_id).await;
    hide(&h, &ids[1], "rights").await;
    let (_, _, held) = h.post("/v1/publications", &req).await;
    assert_eq!(held["publication"]["state"], "held");
    assert!(held["publication"].get("audio").is_none());
    h.finish().await;
}

#[tokio::test]
async fn admin_and_maker_refusals_do_not_depend_on_the_query_or_body_that_came_with_them() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    // A bad query, a bad body, and no secret: still the identical admin refusal.
    let (s1, _, b1) = admin(&h, "GET", "/admin/reports?limit=abc", None, None).await;
    let (s2, _, b2) = admin(
        &h,
        "POST",
        &format!("/admin/publications/{}/hide", ids[1]),
        None,
        Some(&json!({ "nonsense": 1 })),
    )
    .await;
    assert_eq!((s1, s2), (StatusCode::FORBIDDEN, StatusCode::FORBIDDEN));
    assert_eq!(b1, b2);
    assert_eq!(b1["type"], "urn:graft:problem:admin-refused");
    // The maker route with a wrong key and a malformed body: the manage-key refusal, not a 400.
    let (s3, _, b3) = h
        .send(
            "PUT",
            &format!("/v1/publications/{}/fork-permission", ids[1]),
            &[("x-graft-manage-key", &"ab".repeat(32))],
            Some(&json!({ "bogus": true })),
        )
        .await;
    assert_eq!(
        (s3, b3["type"].as_str()),
        (
            StatusCode::FORBIDDEN,
            Some("urn:graft:problem:manage-key-refused")
        )
    );
    h.finish().await;
}

#[tokio::test]
async fn publishing_still_works_when_only_one_render_may_run_at_a_time() {
    let h = Harness::configured(|c| c.max_concurrent_renders = 1).await;
    let ids = chain_of_four(&h).await;
    let tasks: Vec<_> = (0..6)
        .map(|i| {
            let client = h.client();
            let req = body(&ids[0], 4_000 + i, 60 + i);
            tokio::spawn(async move { client.post_retrying("/v1/publications", &req, 6).await })
        })
        .collect();
    for t in tasks {
        let (status, res, _) = t.await.expect("task");
        assert_eq!(status, StatusCode::CREATED, "{res}");
    }
    h.finish().await;
}
