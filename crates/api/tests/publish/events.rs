//! Server events over HTTP: a publish or a report writes its event in the same transaction, and a
//! request that writes nothing writes no event.

use super::common::Harness;
use super::{body, source};
use axum::http::StatusCode;
use serde_json::json;

async fn events(h: &Harness) -> Vec<(String, Option<String>, Option<String>)> {
    sqlx::query_as("SELECT kind, publication_id, detail FROM events ORDER BY seq")
        .fetch_all(h.db.store.pool())
        .await
        .expect("events")
}

#[tokio::test]
async fn a_successful_publish_yields_exactly_one_event_and_a_replay_or_refusal_yields_none() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let baseline = events(&h).await;
    assert_eq!(baseline.len(), 1, "the seeded source");

    let request = body(&parent, 0, 24_000, 3, 2, 1);
    let (status, _, res) = h.post("/v1/publications", &request).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let created = res["publication"]["id"].as_str().expect("id").to_owned();
    let after = events(&h).await;
    assert_eq!(after.len(), 2);
    assert_eq!(
        after[1],
        (
            "publication_created".to_owned(),
            Some(created),
            Some("flip".to_owned())
        )
    );

    // The same request again: same publication, no new event.
    let (status, _, _) = h.post("/v1/publications", &request).await;
    assert_eq!(status, StatusCode::OK);
    // Refused by each kind of rule: a bad cut, a bad speed, a missing parent, a key conflict.
    for refused in [
        body(&parent, 100, 100, 3, 2, 2),
        body(&parent, 0, 24_000, 9, 1, 3),
        body("no-such-stage-0000", 0, 24_000, 3, 2, 4),
        body(&parent, 0, 20_000, 3, 2, 1),
    ] {
        let (status, _, _) = h.post("/v1/publications", &refused).await;
        assert!(!status.is_success(), "{refused}");
    }
    assert_eq!(events(&h).await.len(), 2, "no refusal left an event");
    h.finish().await;
}

#[tokio::test]
async fn a_report_yields_one_event_with_its_category_and_a_report_of_nothing_yields_none() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (status, _, _) = h
        .post(
            "/v1/reports",
            &json!({ "publication_id": parent, "category": "harmful", "note": "a private note" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _, _) = h
        .post(
            "/v1/reports",
            &json!({ "publication_id": "no-such-stage-0000", "category": "spam" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let all = events(&h).await;
    assert_eq!(all.len(), 2, "the seeded source and one report");
    assert_eq!(
        all[1],
        (
            "report_filed".to_owned(),
            Some(parent),
            Some("harmful".to_owned())
        )
    );
    h.finish().await;
}
