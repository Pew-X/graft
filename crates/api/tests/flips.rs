#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! The flips of a stage against a real Postgres: what it lists and hides, in what order, how a
//! cursor pages it, and what it never shows. Each test names the guarantee it protects.

mod common;

use axum::http::StatusCode;
use common::{Harness, is_problem};
use graft_domain::ids::PublicationId;
use graft_domain::limits::Limits;
use graft_storage::Outcome;
use serde_json::Value;

fn id_of(outcome: &Outcome) -> PublicationId {
    match outcome {
        Outcome::Created(s) | Outcome::Existing(s) => s.id.clone(),
        Outcome::KeyConflict => panic!("unexpected conflict"),
    }
}

async fn hide(h: &Harness, id: &PublicationId, reason: Option<&str>) {
    sqlx::query("UPDATE publications SET hidden_reason = $2 WHERE id = $1")
        .bind(id.as_str())
        .bind(reason)
        .execute(h.db.store.pool())
        .await
        .expect("hide");
}

/// A source with `n` flips of it, published in order, the ids oldest first.
async fn parent_with(h: &Harness, n: u8) -> (PublicationId, Vec<PublicationId>) {
    let root = id_of(&h.seed("seed:door", 0).await);
    let mut flips = Vec::new();
    for i in 0..n {
        flips.push(
            h.flip(&format!("seed:f{i}"), &root, i.saturating_add(2))
                .await,
        );
    }
    (root, flips)
}

fn ids(body: &Value) -> Vec<String> {
    body["flips"]
        .as_array()
        .expect("flips")
        .iter()
        .map(|f| f["id"].as_str().expect("id").to_owned())
        .collect()
}

#[tokio::test]
async fn the_flips_come_newest_first_with_their_computed_facts_and_no_audio() {
    let h = Harness::new().await;
    let (root, flips) = parent_with(&h, 3).await;
    let (status, headers, body) = h.get(&format!("/v1/publications/{root}/flips")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!is_problem(&headers));
    assert_eq!(
        headers.get("cache-control").and_then(|v| v.to_str().ok()),
        Some("public, max-age=3")
    );
    let expected: Vec<String> = flips.iter().rev().map(ToString::to_string).collect();
    assert_eq!(ids(&body), expected);
    assert_eq!(body["total"], 3);
    assert_eq!(body["next"], Value::Null);
    let first = &body["flips"][0];
    assert_eq!(first["title"], "slower");
    assert_eq!(first["author"], "jo");
    assert_eq!(first["cut"]["start"], 0);
    assert_eq!(first["cut"]["end"], 24_000);
    assert_eq!(first["speed"]["p"], 3);
    assert_eq!(first["speed"]["q"], 2);
    assert_eq!(first["frames"], 16_000);
    // the shape is closed: no audio, no key, no hash of one
    let text = body.to_string();
    for word in ["audio", "url", "manage", "hash", "retry"] {
        assert!(!text.contains(word), "{word} leaked: {text}");
    }
    h.finish().await;
}

#[tokio::test]
async fn a_stage_with_no_flips_lists_none_and_a_stage_with_one_lists_one() {
    let h = Harness::new().await;
    let (root, flips) = parent_with(&h, 1).await;
    let (_, _, body) = h.get(&format!("/v1/publications/{root}/flips")).await;
    assert_eq!(
        (body["total"].clone(), ids(&body)),
        (1.into(), vec![flips[0].to_string()])
    );
    let (_, _, none) = h.get(&format!("/v1/publications/{}/flips", flips[0])).await;
    assert_eq!(none["total"], 0);
    assert_eq!(none["flips"].as_array().expect("flips").len(), 0);
    assert_eq!(none["next"], Value::Null);
    h.finish().await;
}

#[tokio::test]
async fn a_malformed_or_unknown_id_answers_the_same_404_as_the_other_reads() {
    let h = Harness::new().await;
    let unknown = PublicationId::seeded("seed:nothing");
    let (s1, h1, b1) = h.get(&format!("/v1/publications/{unknown}/flips")).await;
    let (s2, _, b2) = h.get("/v1/publications/not-an-id/flips").await;
    assert_eq!((s1, s2), (StatusCode::NOT_FOUND, StatusCode::NOT_FOUND));
    assert!(is_problem(&h1));
    assert_eq!(b1, b2, "the same body for a bad id and a missing one");
    h.finish().await;
}

#[tokio::test]
async fn each_hidden_state_is_left_out_and_the_total_counts_only_what_is_listed() {
    let h = Harness::new().await;
    let (root, flips) = parent_with(&h, 4).await;
    // withdrawn by the maker or the operator: not listed
    hide(&h, &flips[0], Some("withdrawn")).await;
    // hidden for rights: not listed
    hide(&h, &flips[1], Some("rights")).await;
    let (_, _, body) = h.get(&format!("/v1/publications/{root}/flips")).await;
    assert_eq!(body["total"], 2);
    assert_eq!(ids(&body), vec![flips[3].to_string(), flips[2].to_string()]);
    // clearing the hides lists them again, in their old places
    hide(&h, &flips[0], None).await;
    hide(&h, &flips[1], None).await;
    let (_, _, again) = h.get(&format!("/v1/publications/{root}/flips")).await;
    assert_eq!(again["total"], 4);
    h.finish().await;
}

#[tokio::test]
async fn a_rights_hide_on_the_stage_holds_every_flip_so_none_is_listed_and_the_chain_read_agrees() {
    let h = Harness::new().await;
    let (root, flips) = parent_with(&h, 2).await;
    hide(&h, &root, Some("rights")).await;
    let (status, _, body) = h.get(&format!("/v1/publications/{root}/flips")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 0);
    assert_eq!(ids(&body).len(), 0);
    // the chain read of a flip says held: the two reads never disagree
    let (_, _, chain) = h.get(&format!("/v1/chains/{}", flips[0])).await;
    assert_eq!(chain["stages"][1]["state"], "held");
    h.finish().await;
}

#[tokio::test]
async fn a_rights_hide_above_the_stage_holds_its_flips_too() {
    let h = Harness::new().await;
    let root = id_of(&h.seed("seed:door", 0).await);
    let middle = h.flip("seed:mid", &root, 2).await;
    let leaf = h.flip("seed:leaf", &middle, 3).await;
    hide(&h, &root, Some("rights")).await;
    let (_, _, body) = h.get(&format!("/v1/publications/{middle}/flips")).await;
    assert_eq!(body["total"], 0);
    let (_, _, chain) = h.get(&format!("/v1/chains/{leaf}")).await;
    assert_eq!(chain["stages"][2]["state"], "held");
    h.finish().await;
}

#[tokio::test]
async fn a_withdrawn_stage_still_lists_its_flips_because_they_keep_playing() {
    let h = Harness::new().await;
    let (root, flips) = parent_with(&h, 2).await;
    hide(&h, &root, Some("withdrawn")).await;
    let (_, _, body) = h.get(&format!("/v1/publications/{root}/flips")).await;
    assert_eq!(body["total"], 2);
    let (_, _, chain) = h.get(&format!("/v1/chains/{}", flips[1])).await;
    assert_eq!(chain["stages"][1]["state"], "available");
    h.finish().await;
}

#[tokio::test]
async fn a_stage_closed_to_new_flips_still_lists_the_flips_it_has() {
    let h = Harness::new().await;
    let (root, _) = parent_with(&h, 2).await;
    sqlx::query("UPDATE publications SET fork_permitted = false WHERE id = $1")
        .bind(root.as_str())
        .execute(h.db.store.pool())
        .await
        .expect("close");
    let (_, _, body) = h.get(&format!("/v1/publications/{root}/flips")).await;
    assert_eq!(body["total"], 2);
    h.finish().await;
}

#[tokio::test]
async fn a_stage_at_the_depth_cap_lists_nothing_because_it_can_have_no_flips() {
    let limits = Limits {
        max_chain_depth: 2,
        ..Limits::default()
    };
    let h = Harness::with_limits(limits).await;
    let root = id_of(&h.seed("seed:door", 0).await);
    let f1 = h.flip("seed:f1", &root, 2).await;
    let (status, _, body) = h.get(&format!("/v1/publications/{f1}/flips")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 0);
    h.finish().await;
}

#[tokio::test]
async fn pages_follow_the_cursor_with_no_repeat_and_no_gap() {
    let h = Harness::new().await;
    let (root, flips) = parent_with(&h, 7).await;
    let mut seen = Vec::new();
    let mut uri = format!("/v1/publications/{root}/flips?limit=3");
    let mut pages = 0;
    loop {
        let (status, _, body) = h.get(&uri).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["total"], 7);
        seen.extend(ids(&body));
        pages += 1;
        match body["next"].as_str() {
            Some(next) => uri = format!("/v1/publications/{root}/flips?limit=3&cursor={next}"),
            None => break,
        }
    }
    assert_eq!(pages, 3, "seven flips at three a page");
    let expected: Vec<String> = flips.iter().rev().map(ToString::to_string).collect();
    assert_eq!(seen, expected);
    h.finish().await;
}

#[tokio::test]
async fn a_flip_withdrawn_or_published_between_two_pages_never_repeats_or_skips_another() {
    let h = Harness::new().await;
    let (root, flips) = parent_with(&h, 6).await;
    let (_, _, first) = h
        .get(&format!("/v1/publications/{root}/flips?limit=2"))
        .await;
    let next = first["next"].as_str().expect("next").to_owned();
    // after the first page: a flip is withdrawn from a later page, and a newer one is published
    hide(&h, &flips[2], Some("withdrawn")).await;
    let newer = h.flip("seed:newer", &root, 9).await;
    let (_, _, second) = h
        .get(&format!(
            "/v1/publications/{root}/flips?limit=2&cursor={next}"
        ))
        .await;
    // flips are [0..5], newest first 5 4 | 3 2 1 0; 2 is withdrawn, so the second page is 3 and 1
    assert_eq!(
        ids(&second),
        vec![flips[3].to_string(), flips[1].to_string()]
    );
    assert!(
        !ids(&second).contains(&newer.to_string()),
        "a newer flip belongs to an earlier page"
    );
    h.finish().await;
}

#[tokio::test]
async fn a_bad_limit_or_a_cursor_that_is_not_this_stages_is_a_clear_400() {
    let h = Harness::new().await;
    let (root, flips) = parent_with(&h, 3).await;
    let (_, _, first) = h
        .get(&format!("/v1/publications/{root}/flips?limit=1"))
        .await;
    let cursor = first["next"].as_str().expect("next").to_owned();
    let other = h.flip("seed:other-parent", &root, 9).await;
    for uri in [
        format!("/v1/publications/{root}/flips?limit=0"),
        format!("/v1/publications/{root}/flips?limit=51"),
        format!("/v1/publications/{root}/flips?limit=abc"),
        format!("/v1/publications/{root}/flips?cursor=garbage"),
        format!("/v1/publications/{root}/flips?cursor={}", "a".repeat(5000)),
        // a replayed cursor of another stage
        format!("/v1/publications/{other}/flips?cursor={cursor}"),
        format!("/v1/publications/{}/flips?cursor={cursor}", flips[0]),
    ] {
        let (status, headers, body) = h.get(&uri).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{}: {body}",
            &uri[..uri.len().min(120)]
        );
        assert!(is_problem(&headers));
        assert!(
            headers.get("cache-control").and_then(|v| v.to_str().ok()) != Some("public, max-age=3"),
            "a refusal is not cached"
        );
    }
    h.finish().await;
}

#[tokio::test]
async fn a_thousand_flips_page_through_and_the_parent_index_can_serve_the_read() {
    let h = Harness::new().await;
    let root = id_of(&h.seed("seed:door", 0).await);
    // a thousand flips, written the way the harness writes one (each is a real, hashed record)
    for i in 0..1000u32 {
        h.flip(&format!("seed:bulk{i}"), &root, (i % 250) as u8 + 2)
            .await;
    }
    sqlx::query("ANALYZE content_records")
        .execute(h.db.store.pool())
        .await
        .expect("analyze");
    sqlx::query("ANALYZE publications")
        .execute(h.db.store.pool())
        .await
        .expect("analyze");
    // With a table this small the planner may rightly read it whole; what is proved is that the
    // parent index can serve the read, which is what keeps it cheap at the size a stage can reach.
    let mut tx = h.db.store.pool().begin().await.expect("begin");
    sqlx::query("SET LOCAL enable_seqscan = off")
        .execute(&mut *tx)
        .await
        .expect("set");
    let plan: Vec<String> = sqlx::query_scalar(
        "EXPLAIN SELECT p.id FROM content_records c JOIN publications p ON p.content_id = c.id \
         WHERE c.parent_publication_id = $1 AND p.hidden_reason IS NULL \
         ORDER BY p.created_at DESC, p.id DESC LIMIT 25",
    )
    .bind(root.as_str())
    .fetch_all(&mut *tx)
    .await
    .expect("plan");
    tx.rollback().await.expect("rollback");
    assert!(
        plan.iter().any(|l| l.contains("content_records_parent")),
        "the children are found by the parent index: {plan:#?}"
    );
    let mut seen = 0usize;
    let mut uri = format!("/v1/publications/{root}/flips?limit=50");
    loop {
        let (status, _, body) = h.get(&uri).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["total"], 1000);
        seen += ids(&body).len();
        match body["next"].as_str() {
            Some(next) => uri = format!("/v1/publications/{root}/flips?limit=50&cursor={next}"),
            None => break,
        }
    }
    assert_eq!(seen, 1000);
    h.finish().await;
}

#[tokio::test]
async fn the_openapi_document_describes_the_flips_read() {
    let h = Harness::new().await;
    let (_, _, doc) = h.get("/openapi.json").await;
    assert!(doc["paths"]["/v1/publications/{id}/flips"]["get"].is_object());
    assert!(doc["components"]["schemas"]["FlipsView"].is_object());
    h.finish().await;
}
