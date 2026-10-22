//! Abuse guardrails over HTTP, against a real Postgres: the kill switch, the per-visitor limits,
//! the global publish cap and the storage admission threshold. Each test names the guarantee it
//! protects.

use super::common::{Harness, is_problem};
use super::{body, source};
use axum::http::StatusCode;
use graft_storage::BlobStore;
use serde_json::{Value, json};

const SECRET: &str = "an-operator-secret-0123456789";
const ADMIN: &str = "x-graft-admin-secret";

async fn with_secret(tweak: impl FnOnce(&mut graft_api::config::Config)) -> Harness {
    Harness::configured(|c| {
        c.admin_secret = Some(SECRET.to_owned());
        tweak(c);
    })
    .await
}

async fn switch(h: &Harness, publishing: bool) {
    let (status, _, res) = h
        .send(
            "PUT",
            "/admin/switch",
            &[(ADMIN, SECRET)],
            Some(&json!({ "publishing": publishing })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{res}");
}

async fn stored_bytes(h: &Harness) -> u64 {
    h.blobs
        .list()
        .await
        .expect("list")
        .iter()
        .map(|b| b.size)
        .sum()
}

/// One flip of the seeded source with the retry key numbered `n`.
async fn flip_from(h: &Harness, ip: &str, parent: &str, n: u32) -> (StatusCode, Value) {
    let (status, _, res) = h
        .send_from(
            ip,
            "POST",
            "/v1/publications",
            &[],
            Some(&body(parent, 0, 24_000, 3, 2, n)),
        )
        .await;
    (status, res)
}

#[tokio::test]
async fn closing_the_kill_switch_stops_publishing_at_once_and_reopening_restores_it() {
    let h = with_secret(|_| {}).await;
    let parent = source(&h).await;
    assert_eq!(
        flip_from(&h, "203.0.113.1", &parent, 1).await.0,
        StatusCode::CREATED
    );

    switch(&h, false).await;
    let (status, res) = flip_from(&h, "203.0.113.1", &parent, 2).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{res}");
    assert_eq!(res["type"], "urn:graft:problem:publishing-off");
    assert!(
        res["detail"]
            .as_str()
            .is_some_and(|d| d.contains("switched off")),
        "a kind message: {res}"
    );
    assert_eq!(
        h.count("publications").await,
        2,
        "the refused flip wrote nothing"
    );
    // Reads keep working while publishing is closed.
    assert_eq!(
        h.get(&format!("/v1/chains/{parent}")).await.0,
        StatusCode::OK
    );

    switch(&h, true).await;
    assert_eq!(
        flip_from(&h, "203.0.113.1", &parent, 2).await.0,
        StatusCode::CREATED
    );
    h.finish().await;
}

#[tokio::test]
async fn the_default_applies_until_the_operator_sets_the_switch_and_another_instances_change_is_seen_within_the_cache_time()
 {
    let h = with_secret(|c| c.guardrails.publishing_default = false).await;
    let parent = source(&h).await;
    let (status, res) = flip_from(&h, "203.0.113.1", &parent, 1).await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "closed by the default: {res}"
    );
    switch(&h, true).await;
    assert_eq!(
        flip_from(&h, "203.0.113.1", &parent, 1).await.0,
        StatusCode::CREATED
    );

    // Another instance closes it by writing the setting directly: this one keeps the old answer
    // until the cache time (2 s by default) has passed.
    h.db.store
        .set_setting("publishing", "off")
        .await
        .expect("set");
    assert_eq!(
        flip_from(&h, "203.0.113.1", &parent, 2).await.0,
        StatusCode::CREATED
    );
    h.clock.advance(2.5);
    let (status, res) = flip_from(&h, "203.0.113.1", &parent, 3).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{res}");
    h.finish().await;
}

/// Every route that changes anything, and whether the kill switch closes it. A route added to the
/// public interface without a row here fails the cross-check below, so the switch cannot forget a
/// write route.
const WRITE_ROUTES: &[(&str, &str, bool)] = &[
    ("POST", "/v1/publications", true),
    ("POST", "/v1/events", true),
    // Reports stay open so a problem can always be raised; a maker can always withdraw; the
    // operator's own routes are how the switch is reopened.
    ("POST", "/v1/reports", false),
    ("PUT", "/v1/publications/{id}/fork-permission", false),
    ("POST", "/v1/publications/{id}/withdraw", false),
    ("PUT", "/admin/switch", false),
    ("POST", "/admin/publications/{id}/hide", false),
    ("DELETE", "/admin/publications/{id}/hide", false),
];

#[tokio::test]
async fn every_write_route_is_classified_and_the_switch_closes_exactly_those_that_add_publications()
{
    // Cross-check: every non-read operation in the public interface document has a row.
    let doc = graft_api::openapi::document();
    for (path, item) in doc["paths"].as_object().expect("paths") {
        for method in item.as_object().expect("operations").keys() {
            if method != "get" {
                assert!(
                    WRITE_ROUTES
                        .iter()
                        .any(|(m, p, _)| m.eq_ignore_ascii_case(method) && p == path),
                    "{method} {path} is a write route with no row in WRITE_ROUTES: decide whether the kill switch closes it"
                );
            }
        }
    }
    let h = with_secret(|_| {}).await;
    let parent = source(&h).await;
    switch(&h, false).await;
    for (method, template, closed) in WRITE_ROUTES {
        let uri = template.replace("{id}", &parent);
        let payload = json!({});
        let (status, _, res) = h
            .send_from(
                "203.0.113.9",
                method,
                &uri,
                &[(ADMIN, SECRET)],
                if *method == "DELETE" {
                    None
                } else {
                    Some(&payload)
                },
            )
            .await;
        let off = res["type"] == "urn:graft:problem:publishing-off";
        assert_eq!(
            off, *closed,
            "{method} {template} with the switch closed answered {status}: {res}"
        );
        if *closed {
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        }
    }
    h.finish().await;
}

#[tokio::test]
async fn simultaneous_requests_from_one_address_get_exactly_the_limit_and_the_rest_wait() {
    let h = with_secret(|c| c.guardrails.publish_per_ip.count = 3).await;
    let parent = source(&h).await;
    let client = h.client();
    let tasks: Vec<_> = (0..12u32)
        .map(|n| {
            let (client, parent) = (client.clone(), parent.clone());
            tokio::spawn(async move {
                client
                    .send_from(
                        "203.0.113.50",
                        "POST",
                        "/v1/publications",
                        &[],
                        Some(&body(&parent, 0, 24_000, 3, 2, 100 + n)),
                    )
                    .await
            })
        })
        .collect();
    let (mut accepted, mut refused) = (0, 0);
    for t in tasks {
        let (status, headers, res) = t.await.expect("task");
        match status {
            StatusCode::CREATED => accepted += 1,
            StatusCode::TOO_MANY_REQUESTS => {
                refused += 1;
                assert!(is_problem(&headers));
                assert_eq!(res["type"], "urn:graft:problem:rate-limited");
                let wait: u32 = headers["retry-after"]
                    .to_str()
                    .expect("ascii")
                    .parse()
                    .expect("seconds");
                assert!(wait >= 1, "a refusal says how long to wait");
            }
            other => panic!("unexpected {other}: {res}"),
        }
    }
    assert_eq!(
        (accepted, refused),
        (3, 9),
        "every request is accepted or refused, none lost"
    );
    assert_eq!(h.count("publications").await, 1 + 3);
    // Another address is a different visitor with its own allowance.
    assert_eq!(
        flip_from(&h, "203.0.113.51", &parent, 200).await.0,
        StatusCode::CREATED
    );
    // After the window the first address is allowed again.
    h.clock.advance(3601.0);
    assert_eq!(
        flip_from(&h, "203.0.113.50", &parent, 201).await.0,
        StatusCode::CREATED
    );
    h.finish().await;
}

#[tokio::test]
async fn behind_a_trusted_proxy_the_visitor_is_the_address_the_proxy_appended_not_one_the_visitor_wrote()
 {
    let h = with_secret(|c| {
        c.guardrails.publish_per_ip.count = 1;
        c.guardrails.trusted_proxy_hops = 1;
    })
    .await;
    let parent = source(&h).await;
    let publish = async |forwarded: &str, n: u32| {
        h.send_from(
            "10.0.0.5",
            "POST",
            "/v1/publications",
            &[("x-forwarded-for", forwarded)],
            Some(&body(&parent, 0, 24_000, 3, 2, n)),
        )
        .await
        .0
    };
    assert_eq!(
        publish("1.1.1.1, 203.0.113.60", 300).await,
        StatusCode::CREATED
    );
    // The same visitor writing a different left-hand entry is still that visitor.
    assert_eq!(
        publish("9.9.9.9, 203.0.113.60", 301).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    // A different address behind the same proxy is another visitor.
    assert_eq!(
        publish("1.1.1.1, 203.0.113.61", 302).await,
        StatusCode::CREATED
    );
    h.finish().await;
}

#[tokio::test]
async fn an_address_that_keeps_failing_the_admin_secret_waits_even_with_the_right_one() {
    let h = with_secret(|c| c.guardrails.admin_failures_per_ip.count = 3).await;
    let wrong = [(ADMIN, "a-wrong-secret-0123456789abc")];
    let right = [(ADMIN, SECRET)];
    for _ in 0..3 {
        let (status, _, _) = h
            .send_from("203.0.113.70", "GET", "/admin/reports", &wrong, None)
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let (status, headers, res) = h
        .send_from("203.0.113.70", "GET", "/admin/reports", &right, None)
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{res}");
    assert!(headers.contains_key("retry-after"));
    let (status, _, _) = h
        .send_from("203.0.113.71", "GET", "/admin/reports", &right, None)
        .await;
    assert_eq!(status, StatusCode::OK, "another address is unaffected");
    h.clock.advance(901.0);
    let (status, _, _) = h
        .send_from("203.0.113.70", "GET", "/admin/reports", &right, None)
        .await;
    assert_eq!(status, StatusCode::OK, "the wait ends with the window");
    h.finish().await;
}

#[tokio::test]
async fn reports_have_their_own_limit_per_address() {
    let h = with_secret(|c| c.guardrails.report_per_ip.count = 2).await;
    let parent = source(&h).await;
    let report = json!({ "publication_id": parent, "category": "spam" });
    for expected in [
        StatusCode::CREATED,
        StatusCode::CREATED,
        StatusCode::TOO_MANY_REQUESTS,
    ] {
        let (status, _, res) = h
            .send_from("203.0.113.80", "POST", "/v1/reports", &[], Some(&report))
            .await;
        assert_eq!(status, expected, "{res}");
    }
    h.finish().await;
}

#[tokio::test]
async fn the_global_cap_admits_the_burst_refuses_the_rest_with_a_reason_and_never_blocks_a_replay()
{
    let h = with_secret(|c| {
        c.guardrails.global_publish_burst = 3;
        c.guardrails.global_publish_per_hour = 1;
    })
    .await;
    let parent = source(&h).await;
    let (mut accepted, mut refused) = (0, 0);
    for n in 0..10 {
        let (status, res) = flip_from(&h, "203.0.113.90", &parent, 500 + n).await;
        match status {
            StatusCode::CREATED => accepted += 1,
            StatusCode::TOO_MANY_REQUESTS => {
                refused += 1;
                assert_eq!(res["type"], "urn:graft:problem:publish-cap", "{res}");
                assert!(res["retry_after_secs"].as_u64().is_some_and(|s| s >= 1));
            }
            other => panic!("unexpected {other}: {res}"),
        }
    }
    assert_eq!(
        (accepted, refused),
        (3, 7),
        "accepted plus refused is every request"
    );
    // A client repeating a publish it already made gets its publication back, budget or not.
    let (status, res) = flip_from(&h, "203.0.113.90", &parent, 500).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    h.finish().await;
}

#[tokio::test]
async fn storage_admission_overshoots_by_less_than_the_documented_bound_then_refuses_politely() {
    let threshold: u64 = 100_000;
    let mut bound = 0;
    let h = with_secret(|c| {
        c.guardrails.global_publish_burst = 3;
        c.guardrails.global_publish_per_hour = 1;
        c.guardrails.storage_refresh_secs = 60;
        bound = c.guardrails.overshoot_bound_bytes(&c.limits);
        // A threshold just above the seeded source, so the first publishes are admitted.
        c.guardrails.storage_limit_bytes = bound + threshold;
    })
    .await;
    let parent = source(&h).await;
    let before = stored_bytes(&h).await;
    assert!(
        before < threshold,
        "the source is below the threshold ({before})"
    );
    // The gauge reads the total once and the clock is frozen: every flip within the burst is
    // admitted however far the real total goes past the threshold.
    let mut created = 0;
    for n in 0..6 {
        if flip_from(&h, "203.0.113.91", &parent, 600 + n).await.0 == StatusCode::CREATED {
            created += 1;
        }
    }
    assert_eq!(created, 3);
    let total = stored_bytes(&h).await;
    assert!(total > threshold, "the threshold was passed ({total})");
    assert!(
        total - threshold <= bound,
        "overshoot {} exceeded the documented bound {bound}",
        total - threshold
    );
    assert!(
        total <= bound + threshold,
        "the host's own limit was never reached"
    );

    // A refresh later the total is seen, and new publishes are refused with a reason.
    h.clock.advance(61.0);
    let rows = (h.count("publications").await, stored_bytes(&h).await);
    let (status, res) = flip_from(&h, "203.0.113.91", &parent, 700).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{res}");
    assert_eq!(res["type"], "urn:graft:problem:storage-full");
    assert_eq!(
        (h.count("publications").await, stored_bytes(&h).await),
        rows,
        "a refused publish stores nothing"
    );
    // Reads are untouched by a full store.
    assert_eq!(
        h.get(&format!("/v1/chains/{parent}")).await.0,
        StatusCode::OK
    );
    h.finish().await;
}
