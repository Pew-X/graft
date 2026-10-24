//! The operator's read of the event path over HTTP, and the line between it and the public facts.

use super::common::Harness;
use super::{ADMIN, SECRET, chain_of_four, harness};
use axum::http::StatusCode;
use graft_events::{BatchConsumer, Consumer};
use graft_storage::{EventKind, NewEvent};
use serde_json::Value;

const HOUR: i64 = 3_600_000;

fn client(n: u32, kind: EventKind, at_ms: i64, publication: &str) -> NewEvent {
    NewEvent {
        event_id: Some(format!("event-id-for-test-{n:06}")),
        kind,
        session_id: Some("session-0001".into()),
        occurred_at_ms: Some(at_ms),
        publication_id: Some(publication.to_owned()),
        detail: None,
    }
}

fn now_ms(h: &Harness) -> i64 {
    (h.clock.now_secs() * 1000.0) as i64
}

use graft_api::guard::Clock;

async fn rollups(h: &Harness, query: &str) -> (StatusCode, Value) {
    let (status, _, res) = h
        .send(
            "GET",
            &format!("/admin/rollups{query}"),
            &[(ADMIN, SECRET)],
            None,
        )
        .await;
    (status, res)
}

#[tokio::test]
async fn the_rollup_read_refuses_without_the_secret_and_answers_with_it() {
    let h = harness().await;
    for headers in [vec![], vec![(ADMIN, "a-wrong-secret-0123456789abcdef")]] {
        let (status, _, res) = h.send("GET", "/admin/rollups", &headers, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{res}");
        assert!(res.get("hours").is_none(), "no data leaks in a refusal");
    }
    let (status, res) = rollups(&h, "").await;
    assert_eq!(status, StatusCode::OK, "{res}");
    for field in ["generated_at_ms", "hours", "relay", "consumer", "note"] {
        assert!(res.get(field).is_some(), "{field} is documented: {res}");
    }
    h.finish().await;
}

#[tokio::test]
async fn backlog_lag_and_hourly_counts_are_exact_under_a_controlled_clock() {
    let h = harness().await;
    let now = now_ms(&h);
    let this_hour = now - now.rem_euclid(HOUR);
    // Three events two, one and half an hour ago (all inside the last 24 hours, whatever the time).
    let events = [
        client(1, EventKind::RollOpened, now - 2 * HOUR, "pub-a"),
        client(2, EventKind::StagePlayed, now - HOUR, "pub-a"),
        client(3, EventKind::StagePlayed, now - HOUR / 2, "pub-b"),
    ];
    h.db.store.append_events(&events).await.expect("append");
    // Nothing delivered or counted yet.
    let (_, res) = rollups(&h, "").await;
    assert_eq!(res["relay"]["unsent"], 3);
    assert_eq!(res["relay"]["oldest_unsent_age_ms"], 2 * HOUR);
    assert_eq!(res["consumer"]["unapplied"], 3);
    assert_eq!(res["consumer"]["oldest_unapplied_age_ms"], 2 * HOUR);
    assert_eq!(res["hours"].as_array().expect("hours").len(), 0);

    // Count the first two.
    let stored = h.db.store.all_events().await.expect("all");
    Consumer::new(h.db.store.clone())
        .apply(&stored[..2])
        .await
        .expect("apply");
    let (_, res) = rollups(&h, "").await;
    assert_eq!(res["consumer"]["unapplied"], 1);
    assert_eq!(res["consumer"]["oldest_unapplied_age_ms"], HOUR / 2);
    let counted: i64 = res["hours"]
        .as_array()
        .expect("hours")
        .iter()
        .flat_map(|h| h["counts"].as_object().expect("counts").values())
        .map(|n| n.as_i64().expect("n"))
        .sum();
    assert_eq!(counted, 2);

    // Time passes: the lag grows by exactly that much.
    h.clock.advance(600.0);
    let (_, res) = rollups(&h, "").await;
    assert_eq!(
        res["consumer"]["oldest_unapplied_age_ms"],
        HOUR / 2 + 600_000
    );
    assert_eq!(res["relay"]["oldest_unsent_age_ms"], 2 * HOUR + 600_000);
    // A window of one hour shows only the current hour (nothing was counted in it).
    let (_, res) = rollups(&h, "?hours=1").await;
    assert!(
        res["hours"]
            .as_array()
            .expect("hours")
            .iter()
            .all(|h| h["hour_ms"].as_i64().expect("hour") >= this_hour),
        "{res}"
    );
    h.finish().await;
}

#[tokio::test]
async fn an_hours_window_outside_one_to_thirty_days_is_refused_by_name() {
    let h = harness().await;
    for query in ["?hours=0", "?hours=721", "?hours=-1", "?hours=x", "?days=3"] {
        let (status, res) = rollups(&h, query).await;
        assert!(
            status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
            "{query}: {status} {res}"
        );
    }
    h.finish().await;
}

#[tokio::test]
async fn the_public_flipped_count_comes_from_publications_and_survives_wiping_every_event() {
    let h = harness().await;
    let ids = chain_of_four(&h).await;
    let (_, _, before) = h
        .send("GET", &format!("/v1/chains/{}", ids[3]), &[], None)
        .await;
    let counts = |chain: &Value| -> Vec<u64> {
        chain["stages"]
            .as_array()
            .or_else(|| chain["entries"].as_array())
            .expect("stages")
            .iter()
            .map(|s| s["flipped_count"].as_u64().expect("count"))
            .collect()
    };
    assert_eq!(counts(&before), [1, 1, 1, 0]);
    // Flood the ledger with client events about the stages, then wipe everything event-derived.
    let flood: Vec<NewEvent> = (0..50)
        .map(|n| client(n, EventKind::FlipStarted, now_ms(&h), &ids[0]))
        .collect();
    h.db.store.append_events(&flood).await.expect("append");
    sqlx::query("TRUNCATE events, processed_events, rollups")
        .execute(h.db.store.pool())
        .await
        .expect("wipe");
    let (_, _, after) = h
        .send("GET", &format!("/v1/chains/{}", ids[3]), &[], None)
        .await;
    assert_eq!(
        counts(&after),
        [1, 1, 1, 0],
        "the public count never reads events"
    );
    h.finish().await;
}

#[tokio::test]
async fn the_metrics_expose_the_relay_backlog_and_the_consumer_lag() {
    let h = harness().await;
    let now = now_ms(&h);
    h.db.store
        .append_events(&[client(1, EventKind::RollOpened, now - 90_000, "pub-a")])
        .await
        .expect("append");
    let text = h.scrape().await;
    assert!(text.contains("graft_relay_backlog 1"), "{text}");
    assert!(text.contains("graft_consumer_lag_seconds 90"), "{text}");
    assert!(text.contains("graft_events_applied_total 0"), "{text}");
    h.finish().await;
}
