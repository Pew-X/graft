#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Seam 1: the public HTTP API against a real Postgres. Each test names the guarantee it protects.

mod common;

use axum::http::StatusCode;
use common::{Harness, is_problem};
use graft_domain::ids::PublicationId;
use graft_domain::limits::Limits;
use graft_storage::Outcome;
use serde_json::Value;

fn id_of(outcome: &Outcome) -> String {
    match outcome {
        Outcome::Created(s) | Outcome::Existing(s) => s.id.to_string(),
        Outcome::KeyConflict => panic!("unexpected conflict"),
    }
}

fn strip_clock(v: &mut Value) {
    match v {
        Value::Object(map) => {
            map.remove("created_at_ms");
            map.values_mut().for_each(strip_clock);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_clock),
        _ => {}
    }
}

#[tokio::test]
async fn seeding_twice_creates_exactly_one_root_publication() {
    let h = Harness::new().await;
    let first = h.seed("seed:door", 0).await;
    let second = h.seed("seed:door", 0).await;
    assert!(matches!(first, Outcome::Created(_)));
    assert!(matches!(second, Outcome::Existing(_)));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM publications")
        .fetch_one(h.db.store.pool())
        .await
        .expect("count");
    assert_eq!(n, 1);
    assert_eq!(h.blobs.len(), 1, "the audio is stored once");
    h.finish().await;
}

#[tokio::test]
async fn a_chain_of_one_returns_the_source_with_declared_evidence_computed_facts_and_a_blob_url() {
    let h = Harness::new().await;
    let id = id_of(&h.seed("seed:door", 0).await);
    let (status, headers, body) = h.get(&format!("/v1/chains/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!is_problem(&headers));
    let stages = body["stages"].as_array().expect("stages");
    assert_eq!(stages.len(), 1);
    let s = &stages[0];
    assert_eq!(
        (s["state"].as_str(), s["kind"].as_str()),
        (Some("available"), Some("source"))
    );
    assert_eq!(s["author"], "pat");
    assert!(
        s["audio"]["url"]
            .as_str()
            .expect("url")
            .starts_with("memory://blob/")
    );
    let line = |role: &str| {
        s["lines"]
            .as_array()
            .expect("lines")
            .iter()
            .find(|l| l["role"] == role)
            .cloned()
            .expect(role)
    };
    assert_eq!(line("licence")["value"], "own recording");
    assert_eq!(line("licence")["honesty"], "declared");
    assert_eq!(line("renderer")["honesty"], "computed");
    assert_eq!(line("rights")["honesty"], "unknown");
    assert_eq!(s["details"]["cut"]["end"], 48_000);
    assert_eq!(s["details"]["speed"], Value::Null);
    assert_eq!(body["truncated"], Value::Null);
    h.finish().await;
}

#[tokio::test]
async fn no_json_object_repeats_a_key() {
    // serde_json::Value hides duplicate keys, so look at the raw text: one "state" per entry.
    let h = Harness::new().await;
    let id = id_of(&h.seed("seed:door", 0).await);
    for uri in [format!("/v1/chains/{id}"), format!("/v1/publications/{id}")] {
        let raw = h.raw(&uri).await;
        assert_eq!(raw.matches("\"state\"").count(), 1, "{raw}");
    }
    h.finish().await;
}

#[tokio::test]
async fn a_chain_lists_stages_source_first_with_flipped_counts_from_publications_data() {
    let h = Harness::new().await;
    let root = PublicationId::parse(&id_of(&h.seed("seed:door", 0).await)).expect("id");
    let f1 = h.flip("seed:f1", &root, 2).await;
    let f2 = h.flip("seed:f2", &f1, 3).await;
    h.flip("seed:f3", &f1, 4).await;
    let (_, _, body) = h.get(&format!("/v1/chains/{f2}")).await;
    let stages = body["stages"].as_array().expect("stages");
    let shape: Vec<(&str, u64)> = stages
        .iter()
        .map(|s| {
            (
                s["kind"].as_str().expect("kind"),
                s["flipped_count"].as_u64().expect("count"),
            )
        })
        .collect();
    assert_eq!(shape, vec![("source", 1), ("flip", 2), ("flip", 0)]);
    assert_eq!(stages[1]["parent_id"], stages[0]["id"]);
    assert_eq!(stages[1]["details"]["speed"]["p"], 3);
    h.finish().await;
}

#[tokio::test]
async fn an_unknown_or_malformed_id_gets_the_same_problem_details_not_found() {
    let h = Harness::new().await;
    let unknown = PublicationId::from_bits(42);
    let (s1, h1, b1) = h.get(&format!("/v1/chains/{unknown}")).await;
    let (s2, _, b2) = h.get("/v1/chains/not-an-id").await;
    let (s3, _, b3) = h.get(&format!("/v1/publications/{unknown}")).await;
    assert_eq!(
        (s1, s2, s3),
        (
            StatusCode::NOT_FOUND,
            StatusCode::NOT_FOUND,
            StatusCode::NOT_FOUND
        )
    );
    assert!(is_problem(&h1));
    assert_eq!(b1["type"], "urn:graft:problem:not-found");
    assert_eq!(
        b1, b2,
        "a malformed id is indistinguishable from a missing one"
    );
    assert_eq!(b1, b3);
    h.finish().await;
}

#[tokio::test]
async fn responses_never_contain_the_manage_key_hash() {
    let h = Harness::new().await;
    let id = id_of(&h.seed("seed:door", 0).await);
    let secret = vec![0xabu8; 32];
    sqlx::query("UPDATE publications SET manage_key_hash = $1")
        .bind(&secret)
        .execute(h.db.store.pool())
        .await
        .expect("set");
    for uri in [format!("/v1/chains/{id}"), format!("/v1/publications/{id}")] {
        let (_, _, body) = h.get(&uri).await;
        let text = body.to_string();
        assert!(
            !text.contains(&"ab".repeat(32)) && !text.contains("manage"),
            "{uri} leaked: {text}"
        );
    }
    h.finish().await;
}

#[tokio::test]
async fn an_orphaned_parent_is_reported_as_unavailable_and_the_chain_is_not_shortened() {
    let h = Harness::new().await;
    let root = PublicationId::parse(&id_of(&h.seed("seed:door", 0).await)).expect("id");
    let f = h.flip("seed:f1", &root, 2).await;
    sqlx::query("ALTER TABLE content_records DROP CONSTRAINT content_records_parent_fk")
        .execute(h.db.store.pool())
        .await
        .expect("fk");
    sqlx::query("DELETE FROM publications WHERE id = $1")
        .bind(root.as_str())
        .execute(h.db.store.pool())
        .await
        .expect("delete");
    let (status, _, body) = h.get(&format!("/v1/chains/{f}")).await;
    assert_eq!(status, StatusCode::OK);
    let stages = body["stages"].as_array().expect("stages");
    assert_eq!(stages.len(), 2);
    assert_eq!(stages[0]["state"], "unavailable");
    assert_eq!(stages[0]["id"], root.as_str());
    assert_eq!(stages[1]["state"], "available");
    h.finish().await;
}

#[tokio::test]
async fn a_chain_beyond_the_depth_cap_is_cut_short_and_says_why() {
    let limits = Limits {
        max_chain_depth: 2,
        ..Limits::default()
    };
    let h = Harness::with_limits(limits).await;
    let root = PublicationId::parse(&id_of(&h.seed("seed:door", 0).await)).expect("id");
    let f1 = h.flip("seed:f1", &root, 2).await;
    let f2 = h.flip("seed:f2", &f1, 3).await;
    let (_, _, body) = h.get(&format!("/v1/chains/{f2}")).await;
    assert_eq!(body["stages"].as_array().expect("stages").len(), 2);
    assert_eq!(body["truncated"], "depth_cap");
    h.finish().await;
}

#[tokio::test]
async fn two_independently_seeded_databases_give_identical_ids_hashes_and_chains() {
    let (a, b) = (Harness::new().await, Harness::new().await);
    let mut views = Vec::new();
    for h in [&a, &b] {
        let root = PublicationId::parse(&id_of(&h.seed("seed:door", 0).await)).expect("id");
        let f1 = h.flip("seed:f1", &root, 2).await;
        let (_, _, mut body) = h.get(&format!("/v1/chains/{f1}")).await;
        strip_clock(&mut body);
        views.push(body);
    }
    assert_eq!(
        views[0], views[1],
        "ids, record ids and every fact match across environments"
    );
    a.finish().await;
    b.finish().await;
}

#[tokio::test]
async fn a_source_publication_by_id_matches_its_stage_in_the_chain() {
    let h = Harness::new().await;
    let id = id_of(&h.seed("seed:door", 0).await);
    let (_, _, single) = h.get(&format!("/v1/publications/{id}")).await;
    let (_, _, chain) = h.get(&format!("/v1/chains/{id}")).await;
    assert_eq!(single, chain["stages"][0]);
    h.finish().await;
}

#[tokio::test]
async fn readiness_follows_the_database_it_is_up_with_one_and_down_without() {
    let h = Harness::new().await;
    assert_eq!(h.get("/ready").await.0, StatusCode::OK);
    h.db.store.pool().close().await;
    let (status, headers, body) = h.get("/ready").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(is_problem(&headers));
    assert!(!body.to_string().contains("postgres://"));
    h.finish().await;
}

#[tokio::test]
async fn the_openapi_document_describes_the_read_routes_and_problem_details() {
    let h = Harness::new().await;
    let (status, _, doc) = h.get("/openapi.json").await;
    assert_eq!(status, StatusCode::OK);
    assert!(doc["openapi"].as_str().expect("version").starts_with("3.1"));
    assert!(doc["paths"]["/v1/chains/{id}"]["get"].is_object());
    assert!(doc["paths"]["/v1/publications/{id}"]["get"].is_object());
    assert!(doc["components"]["schemas"]["Problem"].is_object());
    h.finish().await;
}
