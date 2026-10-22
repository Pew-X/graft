//! Client event ingest over HTTP, against a real Postgres: every guard, and what is and is not
//! stored. Each test names the guarantee it protects.

use super::common::Harness;
use super::{body, source};
use axum::http::StatusCode;
use serde_json::{Value, json};

fn event(n: u32, kind: &str, publication: &str) -> Value {
    json!({
        "event_id": format!("client-event-id-{n:06}"),
        "session_id": "session-abcdef01",
        "kind": kind,
        "occurred_at_ms": 0,
        "publication_id": publication,
    })
}

fn batch(events: &[Value]) -> Value {
    json!({ "events": events })
}

async fn post(
    h: &Harness,
    ip: &str,
    headers: &[(&str, &str)],
    payload: &Value,
) -> (StatusCode, Value) {
    let (status, _, res) = h
        .send_from(ip, "POST", "/v1/events", headers, Some(payload))
        .await;
    (status, res)
}

async fn stored(h: &Harness) -> Vec<(String, String, Option<String>)> {
    sqlx::query_as(
        "SELECT kind, origin, session_id FROM events WHERE origin = 'client' ORDER BY seq",
    )
    .fetch_all(h.db.store.pool())
    .await
    .expect("events")
}

fn now_ms(h: &Harness) -> i64 {
    use graft_api::guard::Clock;
    (h.clock.now_secs() * 1000.0) as i64
}

#[tokio::test]
async fn a_valid_batch_is_stored_with_origin_client_and_a_duplicate_id_is_stored_once() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let mut a = event(1, "roll_opened", &parent);
    a["occurred_at_ms"] = json!(now_ms(&h));
    let b = event(2, "stage_played", &parent);
    let (status, res) = post(
        &h,
        "203.0.113.5",
        &[],
        &batch(&[a.clone(), b.clone(), a.clone()]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(
        res,
        json!({ "accepted": 2 }),
        "the repeat inside the batch is one event"
    );
    // The same events again, across batches: nothing new.
    let (_, res) = post(&h, "203.0.113.5", &[], &batch(&[a, b])).await;
    assert_eq!(res, json!({ "accepted": 0 }));
    assert_eq!(
        stored(&h).await,
        vec![
            (
                "roll_opened".into(),
                "client".into(),
                Some("session-abcdef01".into())
            ),
            (
                "stage_played".into(),
                "client".into(),
                Some("session-abcdef01".into())
            ),
        ]
    );
    h.finish().await;
}

#[tokio::test]
async fn an_oversize_batch_an_oversize_body_and_malformed_events_are_refused_and_store_nothing() {
    let h = Harness::configured(|c| c.events.ingest_max_batch = 3).await;
    let parent = source(&h).await;
    let four: Vec<Value> = (0..4).map(|n| event(n, "stage_played", &parent)).collect();
    let (status, res) = post(&h, "203.0.113.5", &[], &batch(&four)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{res}");
    assert_eq!(
        (res["field"].as_str(), res["rule"].as_str()),
        (Some("events"), Some("too_many"))
    );

    let mut bad_id = event(1, "stage_played", &parent);
    bad_id["event_id"] = json!("short");
    let mut bad_session = event(2, "stage_played", &parent);
    bad_session["session_id"] = json!("has spaces in it!");
    // A server kind cannot be reported by a browser.
    let server_kind = event(3, "publication_created", &parent);
    let unknown_kind = event(4, "page_viewed", &parent);
    for (bad, field) in [
        (bad_id, "event_id"),
        (bad_session, "session_id"),
        (server_kind, "kind"),
        (unknown_kind, "kind"),
    ] {
        let (status, res) = post(&h, "203.0.113.5", &[], &batch(&[bad])).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{res}");
        assert_eq!(res["field"], field);
    }
    // An unexpected field is refused rather than ignored: nothing but the event is ever stored.
    let mut extra = event(5, "stage_played", &parent);
    extra["user_agent"] = json!("a browser");
    let (status, _) = post(&h, "203.0.113.5", &[], &batch(&[extra])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A body beyond the cap is cut off before it is read.
    let huge = json!({ "events": [], "padding": "x".repeat(40_000) });
    let (status, _, _) = h
        .send_from("203.0.113.5", "POST", "/v1/events", &[], Some(&huge))
        .await;
    assert!(
        status == StatusCode::PAYLOAD_TOO_LARGE || status == StatusCode::BAD_REQUEST,
        "{status}"
    );
    assert!(stored(&h).await.is_empty());
    h.finish().await;
}

#[tokio::test]
async fn an_event_about_a_publication_that_does_not_exist_is_dropped_and_the_rest_are_kept() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (status, res) = post(
        &h,
        "203.0.113.5",
        &[],
        &batch(&[
            event(1, "stage_played", &parent),
            event(2, "stage_played", "no-such-stage-0000"),
            event(3, "flip_started", &parent),
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(res, json!({ "accepted": 2 }));
    assert_eq!(stored(&h).await.len(), 2);
    h.finish().await;
}

#[tokio::test]
async fn a_batch_with_global_privacy_control_or_do_not_track_stores_nothing() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let payload = batch(&[event(1, "stage_played", &parent)]);
    for header in [("sec-gpc", "1"), ("dnt", "1")] {
        let (status, res) = post(&h, "203.0.113.5", &[header], &payload).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        assert_eq!(res, json!({ "accepted": 0 }));
    }
    assert!(stored(&h).await.is_empty());
    // With the signal off (or `0`), the same batch is stored.
    let (_, res) = post(&h, "203.0.113.5", &[("dnt", "0")], &payload).await;
    assert_eq!(res, json!({ "accepted": 1 }));
    h.finish().await;
}

#[tokio::test]
async fn a_rate_limited_address_gets_retry_after_and_the_kill_switch_closes_the_endpoint() {
    let h = Harness::configured(|c| {
        c.admin_secret = Some("an-operator-secret-0123456789".to_owned());
        c.guardrails.ingest_per_ip.count = 2;
    })
    .await;
    let parent = source(&h).await;
    for n in 0..2 {
        let (status, _) = post(
            &h,
            "203.0.113.6",
            &[],
            &batch(&[event(n, "stage_played", &parent)]),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, headers, res) = h
        .send_from(
            "203.0.113.6",
            "POST",
            "/v1/events",
            &[],
            Some(&batch(&[event(9, "stage_played", &parent)])),
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{res}");
    assert!(headers.contains_key("retry-after"));
    // Another address is unaffected, until the kill switch closes the route for everyone.
    let (status, _) = post(
        &h,
        "203.0.113.7",
        &[],
        &batch(&[event(10, "stage_played", &parent)]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = h
        .send(
            "PUT",
            "/admin/switch",
            &[("x-graft-admin-secret", "an-operator-secret-0123456789")],
            Some(&json!({ "publishing": false })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, res) = post(
        &h,
        "203.0.113.8",
        &[],
        &batch(&[event(11, "stage_played", &parent)]),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{res}");
    assert_eq!(res["type"], "urn:graft:problem:publishing-off");
    h.finish().await;
}

#[tokio::test]
async fn one_session_cannot_flood_even_from_different_addresses() {
    let h = Harness::configured(|c| c.guardrails.ingest_session_events.count = 5).await;
    let parent = source(&h).await;
    let first: Vec<Value> = (0..4).map(|n| event(n, "stage_played", &parent)).collect();
    assert_eq!(
        post(&h, "203.0.113.1", &[], &batch(&first)).await.1,
        json!({ "accepted": 4 })
    );
    // Two more would make six for this session: the whole batch waits.
    let more: Vec<Value> = (10..12)
        .map(|n| event(n, "stage_played", &parent))
        .collect();
    let (status, res) = post(&h, "203.0.113.2", &[], &batch(&more)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{res}");
    assert_eq!(res["type"], "urn:graft:problem:rate-limited");
    assert_eq!(stored(&h).await.len(), 4);
    // After the window it may send again.
    h.clock.advance(3601.0);
    assert_eq!(
        post(&h, "203.0.113.2", &[], &batch(&more)).await.0,
        StatusCode::OK
    );
    h.finish().await;
}

#[tokio::test]
async fn an_absurd_timestamp_is_replaced_and_a_sensible_one_is_kept() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let now = now_ms(&h);
    let mut future = event(1, "stage_played", &parent);
    future["occurred_at_ms"] = json!(now + 90 * 24 * 3_600_000);
    let mut ancient = event(2, "stage_played", &parent);
    ancient["occurred_at_ms"] = json!(now - 90 * 24 * 3_600_000);
    let mut fine = event(3, "stage_played", &parent);
    fine["occurred_at_ms"] = json!(now - 60_000);
    post(&h, "203.0.113.5", &[], &batch(&[future, ancient, fine])).await;
    let times: Vec<i64> = sqlx::query_scalar(
        "SELECT (extract(epoch from occurred_at) * 1000)::bigint FROM events \
         WHERE origin = 'client' ORDER BY seq",
    )
    .fetch_all(h.db.store.pool())
    .await
    .expect("times");
    // The ledger rounds to its own precision; compare within a second.
    let near = |a: i64, b: i64| (a - b).abs() < 5_000;
    assert!(near(times[0], now), "a far-future time becomes now");
    assert!(
        near(times[1], now - 24 * 3_600_000),
        "a far-past time becomes the oldest allowed"
    );
    assert!(near(times[2], now - 60_000), "a sensible time is kept");
    h.finish().await;
}

#[tokio::test]
async fn stored_events_hold_no_address_or_user_agent_and_no_public_response_shows_them() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let ua = "Mozilla/5.0 (a distinctive agent string)";
    let (status, _) = post(
        &h,
        "203.0.113.99",
        &[("user-agent", ua), ("x-forwarded-for", "198.51.100.1")],
        &batch(&[event(7, "stage_played", &parent)]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows: Vec<String> =
        sqlx::query_scalar("SELECT t::text FROM events t WHERE origin = 'client'")
            .fetch_all(h.db.store.pool())
            .await
            .expect("rows");
    assert_eq!(rows.len(), 1);
    for needle in ["203.0.113", "198.51.100", "Mozilla", "distinctive"] {
        assert!(!rows[0].contains(needle), "{needle} in {}", rows[0]);
    }
    // No public route shows anything event-derived.
    for uri in [
        format!("/v1/chains/{parent}"),
        format!("/v1/publications/{parent}"),
    ] {
        let text = h.raw(&uri).await;
        for needle in ["client-event-id-000007", "session-abcdef01", "stage_played"] {
            assert!(!text.contains(needle), "{needle} appears in {uri}");
        }
    }
    h.finish().await;
}

#[tokio::test]
async fn flooding_events_does_not_change_the_public_flipped_count() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let (status, _, res) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 3, 2, 1))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let count = async || {
        let (_, _, chain) = h
            .send("GET", &format!("/v1/chains/{parent}"), &[], None)
            .await;
        chain["stages"][0]["flipped_count"].as_u64().expect("count")
    };
    let before = count().await;
    for round in 0..5u32 {
        let events: Vec<Value> = (0..20)
            .map(|n| {
                let mut e = event(round * 100 + n, "flip_started", &parent);
                e["session_id"] = json!(format!("session-flood-{round:03}"));
                e
            })
            .collect();
        assert_eq!(
            post(&h, "203.0.113.5", &[], &batch(&events)).await.0,
            StatusCode::OK
        );
    }
    assert_eq!(stored(&h).await.len(), 100);
    assert_eq!(count().await, before, "events never feed the public count");
    h.finish().await;
}

/// A sanity bound, not a benchmark: a burst of event batches within the limits does not stop a
/// publish from finishing promptly.
#[tokio::test]
async fn a_burst_of_event_batches_does_not_hold_up_a_publish() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let client = h.client();
    let flood: Vec<_> = (0..40u32)
        .map(|round| {
            let (client, parent) = (client.clone(), parent.clone());
            tokio::spawn(async move {
                let events: Vec<Value> = (0..20)
                    .map(|n| {
                        let mut e = event(round * 100 + n, "stage_played", &parent);
                        e["session_id"] = json!(format!("session-burst-{round:03}"));
                        e
                    })
                    .collect();
                client
                    .send_from(
                        "203.0.113.5",
                        "POST",
                        "/v1/events",
                        &[],
                        Some(&batch(&events)),
                    )
                    .await
                    .0
            })
        })
        .collect();
    let started = std::time::Instant::now();
    let (status, _, res) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 3, 2, 2))
        .await;
    let took = started.elapsed();
    assert_eq!(status, StatusCode::CREATED, "{res}");
    for f in flood {
        assert_eq!(f.await.expect("task"), StatusCode::OK);
    }
    assert!(
        took < std::time::Duration::from_secs(10),
        "the publish took {took:?} during a burst of 40 batches"
    );
    assert_eq!(stored(&h).await.len(), 800);
    h.finish().await;
}
