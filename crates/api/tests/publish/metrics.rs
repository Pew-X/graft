//! Domain metrics move in the expected direction for a scripted scenario. Each test names the
//! guarantee it protects.

use super::common::Harness;
use super::{body, source};
use axum::http::StatusCode;
use serde_json::json;

const SECRET: &str = "an-operator-secret-0123456789";

fn value(text: &str, series: &str) -> f64 {
    text.lines()
        .find_map(|l| {
            l.strip_prefix(series)
                .and_then(|rest| rest.strip_prefix(' '))
        })
        .unwrap_or_else(|| panic!("no series {series} in:\n{text}"))
        .trim()
        .parse()
        .expect("a number")
}

fn absent(text: &str, series: &str) -> bool {
    !text.lines().any(|l| l.starts_with(series))
}

#[tokio::test]
async fn publish_outcomes_renders_and_the_kill_switch_are_counted_by_what_happened() {
    let h = Harness::configured(|c| {
        c.admin_secret = Some(SECRET.to_owned());
        c.max_forks_per_stage_per_hour = 2;
    })
    .await;
    let parent = source(&h).await;
    let counter = |outcome: &str| {
        format!("graft_publish_outcomes_total{{kind=\"flip\",outcome=\"{outcome}\"}}")
    };

    let text = h.raw("/metrics").await;
    assert!(absent(&text, &counter("created")), "nothing yet");
    assert_eq!(value(&text, "graft_publishing_open"), 1.0);

    // Created twice (the cap is 2), a replay, a conflict, a refusal by the cap, a bad parent.
    for n in 1..=2 {
        assert_eq!(
            h.post("/v1/publications", &body(&parent, 0, 24_000, 3, 2, n))
                .await
                .0,
            StatusCode::CREATED
        );
    }
    assert_eq!(
        h.post("/v1/publications", &body(&parent, 0, 24_000, 3, 2, 1))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        h.post("/v1/publications", &body(&parent, 0, 20_000, 3, 2, 1))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.post("/v1/publications", &body(&parent, 0, 24_000, 2, 1, 3))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        h.post(
            "/v1/publications",
            &body("no-such-stage-0000", 0, 24_000, 3, 2, 4)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let text = h.raw("/metrics").await;
    assert_eq!(value(&text, &counter("created")), 2.0);
    assert_eq!(value(&text, &counter("replay")), 1.0);
    assert_eq!(value(&text, &counter("key-conflict")), 1.0);
    assert_eq!(value(&text, &counter("fork-cap")), 1.0);
    assert_eq!(value(&text, &counter("not-found")), 1.0);
    // The accounting adds up: every request was counted exactly once.
    let counted: f64 = text
        .lines()
        .filter(|l| l.starts_with("graft_publish_outcomes_total{"))
        .map(|l| {
            l.rsplit(' ')
                .next()
                .expect("n")
                .parse::<f64>()
                .expect("number")
        })
        .sum();
    assert_eq!(counted, 6.0);

    // Renders: everything that got as far as the transaction rendered first (two created, the
    // replay, the conflict and the cap-refused flip); a missing parent was refused before a render.
    assert_eq!(value(&text, "graft_render_duration_seconds_count"), 5.0);
    assert!(value(&text, "graft_render_duration_seconds_sum") > 0.0);
    assert_eq!(value(&text, "graft_render_failures_total"), 0.0);

    // The kill switch gauge follows the switch.
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
    set(false).await;
    assert_eq!(
        value(&h.raw("/metrics").await, "graft_publishing_open"),
        0.0
    );
    // A refusal by the switch is counted by reason, not as a publish.
    let (status, _, _) = h
        .post("/v1/publications", &body(&parent, 0, 24_000, 3, 2, 9))
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let text = h.raw("/metrics").await;
    assert_eq!(
        value(&text, "graft_refusals_total{reason=\"publishing_off\"}"),
        1.0
    );
    set(true).await;
    assert_eq!(
        value(&h.raw("/metrics").await, "graft_publishing_open"),
        1.0
    );
    h.finish().await;
}

#[tokio::test]
async fn the_metrics_page_holds_only_fixed_names_never_an_id_a_key_or_a_visitors_text() {
    let h = Harness::new().await;
    let parent = source(&h).await;
    let mut request = body(&parent, 0, 24_000, 3, 2, 50);
    request["title"] = json!("a distinctive title");
    request["author"] = json!("a distinctive author");
    h.post("/v1/publications", &request).await;
    let text = h.raw("/metrics").await;
    for needle in [parent.as_str(), "distinctive", "retry-key-for-test"] {
        assert!(!text.contains(needle), "{needle} is on the metrics page");
    }
    h.finish().await;
}
