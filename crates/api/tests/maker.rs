#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Seam 1: what a maker can do with the manage key. Each test names the guarantee it protects.

mod common;

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

const KEY: &str = "x-graft-manage-key";

fn key(n: u32) -> String {
    format!("maker-test-retry-key-{n:04}")
}

fn flip_body(parent: &str, cut_end: u32, n: u32) -> Value {
    json!({
        "parent_id": parent,
        "cut": { "start": 0, "end": cut_end },
        "speed": { "p": 1, "q": 1 },
        "title": "slower",
        "author": "jo",
        "retry_key": key(n),
    })
}

/// A source, a flip of it by a maker (returning the id and manage key), and the source's id.
async fn setup(h: &Harness) -> (String, String, String) {
    let parent = match h.seed("seed:door", 0).await {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    };
    let (status, _, res) = h
        .post("/v1/publications", &flip_body(&parent, 24_000, 1))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    (
        res["publication"]["id"].as_str().expect("id").to_owned(),
        res["manage_key"].as_str().expect("key").to_owned(),
        parent,
    )
}

async fn put_permission(
    h: &Harness,
    id: &str,
    key_value: &str,
    permitted: bool,
) -> (StatusCode, Value) {
    let (s, _, v) = h
        .send(
            "PUT",
            &format!("/v1/publications/{id}/fork-permission"),
            &[(KEY, key_value)],
            Some(&json!({ "permitted": permitted })),
        )
        .await;
    (s, v)
}

async fn withdraw(h: &Harness, id: &str, key_value: &str) -> (StatusCode, Value) {
    let (s, _, v) = h
        .send(
            "POST",
            &format!("/v1/publications/{id}/withdraw"),
            &[(KEY, key_value)],
            None,
        )
        .await;
    (s, v)
}

#[tokio::test]
async fn closing_a_stage_stops_new_flips_only_and_reopening_allows_them_again() {
    let h = Harness::new().await;
    let (stage, manage_key, _parent) = setup(&h).await;
    // A flip of the stage exists before it is closed.
    let (_, _, child) = h
        .post("/v1/publications", &flip_body(&stage, 20_000, 2))
        .await;
    let child_id = child["publication"]["id"].as_str().expect("id").to_owned();

    let (status, state) = put_permission(&h, &stage, &manage_key, false).await;
    assert_eq!(
        (status, &state),
        (
            StatusCode::OK,
            &json!({ "fork_permitted": false, "withdrawn": false })
        )
    );

    // New flips are refused with a clear reason, and the state is visible as a flag in the read model.
    let (status, _, res) = h
        .post("/v1/publications", &flip_body(&stage, 10_000, 3))
        .await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::FORBIDDEN,
            Some("urn:graft:problem:fork-not-permitted")
        )
    );
    let (_, _, chain) = h.get(&format!("/v1/chains/{child_id}")).await;
    assert_eq!(
        chain["stages"][1]["state"], "available",
        "the existing flip still reads and plays"
    );
    assert!(chain["stages"][1]["audio"]["url"].is_string());
    assert_eq!(
        chain["stages"][1]["fork_permitted"], false,
        "the flag is visible, not hidden"
    );
    assert_eq!(
        chain["stages"].as_array().expect("stages").len(),
        3,
        "existing flips and rolls are untouched"
    );

    let (status, state) = put_permission(&h, &stage, &manage_key, true).await;
    assert_eq!(
        (status, &state),
        (
            StatusCode::OK,
            &json!({ "fork_permitted": true, "withdrawn": false })
        )
    );
    let (status, _, res) = h
        .post("/v1/publications", &flip_body(&stage, 10_000, 3))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    h.finish().await;
}

#[tokio::test]
async fn withdrawing_keeps_the_credit_stops_the_audio_keeps_the_chain_whole_and_lets_descendants_play()
 {
    let h = Harness::new().await;
    let (stage, manage_key, parent) = setup(&h).await;
    let (_, _, child) = h
        .post("/v1/publications", &flip_body(&stage, 20_000, 2))
        .await;
    let child_id = child["publication"]["id"].as_str().expect("id").to_owned();

    let before = h.get(&format!("/v1/chains/{child_id}")).await.2;
    let (status, state) = withdraw(&h, &stage, &manage_key).await;
    assert_eq!(
        (status, &state),
        (
            StatusCode::OK,
            &json!({ "fork_permitted": true, "withdrawn": true })
        )
    );

    let (_, _, chain) = h.get(&format!("/v1/chains/{child_id}")).await;
    let stages = chain["stages"].as_array().expect("stages");
    assert_eq!(
        stages.len(),
        before["stages"].as_array().expect("stages").len(),
        "the chain is never silently shortened"
    );
    assert_eq!(stages[0]["state"], "available", "the source is untouched");
    let removed = &stages[1];
    assert_eq!(removed["state"], "no_longer_here");
    assert_eq!(removed["reason"], "withdrawn");
    assert_eq!(removed["title"], "slower", "the credit text is still there");
    assert_eq!(removed["author"], "jo");
    assert!(
        removed["lines"].as_array().is_some_and(|l| !l.is_empty()),
        "credit lines remain"
    );
    assert!(
        removed.get("audio").is_none(),
        "no audio URL is issued for a hidden stage"
    );
    assert!(removed.get("details").is_none());
    assert_eq!(
        stages[2]["state"], "available",
        "a flip built on a withdrawn stage still plays"
    );
    assert!(stages[2]["audio"]["url"].is_string());

    // The same through the single-publication read, and nothing in either leaks the audio's hash.
    let raw = h.raw(&format!("/v1/publications/{stage}")).await;
    assert!(
        raw.contains("no_longer_here") && !raw.contains("memory://"),
        "{raw}"
    );
    // A hash is an identifier, not access: the descendant's record still names the audio it was cut
    // from, but no URL for the hidden stage's audio is issued anywhere.
    let hidden_blob = before["stages"][1]["details"]["output_blob"]
        .as_str()
        .expect("hash")
        .to_owned();
    let urls: Vec<String> = chain["stages"]
        .as_array()
        .expect("stages")
        .iter()
        .filter_map(|s| s["audio"]["url"].as_str().map(ToOwned::to_owned))
        .collect();
    assert!(
        !urls.is_empty() && urls.iter().all(|u| !u.contains(&hidden_blob)),
        "no URL for hidden audio: {urls:?}"
    );

    // Building on it is refused; building on the descendant is not.
    let (status, _, res) = h
        .post("/v1/publications", &flip_body(&stage, 10_000, 3))
        .await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::CONFLICT,
            Some("urn:graft:problem:parent-unavailable")
        )
    );
    let (status, _, res) = h
        .post("/v1/publications", &flip_body(&child_id, 10_000, 4))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let _ = parent;
    h.finish().await;
}

#[tokio::test]
async fn every_way_of_being_refused_gets_the_identical_response() {
    let h = Harness::new().await;
    let (stage, manage_key, parent) = setup(&h).await;
    let (_, _, other) = h
        .post("/v1/publications", &flip_body(&parent, 20_000, 9))
        .await;
    let other_key = other["manage_key"].as_str().expect("key").to_owned();
    let url = |id: &str| format!("/v1/publications/{id}/withdraw");

    let wrong = "ab".repeat(32);
    type Case = (&'static str, String, Vec<(&'static str, String)>);
    let cases: Vec<Case> = vec![
        ("no header", url(&stage), vec![]),
        ("empty key", url(&stage), vec![(KEY, String::new())]),
        (
            "malformed key",
            url(&stage),
            vec![(KEY, "not-a-key".into())],
        ),
        ("wrong key", url(&stage), vec![(KEY, wrong.clone())]),
        (
            "another publication's key",
            url(&stage),
            vec![(KEY, other_key.clone())],
        ),
        (
            "unknown publication",
            url("zzzzzzzzzzzz"),
            vec![(KEY, manage_key.clone())],
        ),
        (
            "malformed id",
            url("not-an-id"),
            vec![(KEY, manage_key.clone())],
        ),
        (
            "a seeded source has no key",
            url(&parent),
            vec![(KEY, manage_key.clone())],
        ),
    ];
    let mut bodies = Vec::new();
    for (name, uri, headers) in &cases {
        let hs: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let (status, response_headers, body) = h.send("POST", uri, &hs, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{name}");
        assert!(is_problem(&response_headers), "{name}");
        assert_eq!(
            body["type"], "urn:graft:problem:manage-key-refused",
            "{name}"
        );
        let text = body.to_string();
        for secret in [&manage_key, &other_key, &wrong] {
            assert!(
                !text.contains(secret.as_str()),
                "{name}: the response echoed a key"
            );
        }
        bodies.push((name, body));
    }
    assert!(
        bodies.windows(2).all(|w| w[0].1 == w[1].1),
        "the refusals must be indistinguishable: {bodies:?}"
    );
    // Nothing was changed by any of them.
    let (_, _, chain) = h.get(&format!("/v1/chains/{stage}")).await;
    assert_eq!(chain["stages"][1]["state"], "available");
    h.finish().await;
}

#[tokio::test]
async fn the_manage_key_is_accepted_only_in_the_header_never_in_the_address_or_the_body() {
    let h = Harness::new().await;
    let (stage, manage_key, _) = setup(&h).await;
    for uri in [
        format!("/v1/publications/{stage}/withdraw?manage_key={manage_key}"),
        format!("/v1/publications/{stage}/withdraw?key={manage_key}"),
    ] {
        let (status, _, body) = h.send("POST", &uri, &[(KEY, &manage_key)], None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(body["type"], "urn:graft:problem:bad-request");
        assert!(!body.to_string().contains(&manage_key));
    }
    // A key in the body is not a thing: unknown fields are refused, and the request does nothing.
    let (status, _, _) = h
        .send(
            "PUT",
            &format!("/v1/publications/{stage}/fork-permission"),
            &[(KEY, &manage_key)],
            Some(&json!({ "permitted": false, "manage_key": manage_key })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, _, chain) = h.get(&format!("/v1/chains/{stage}")).await;
    assert_eq!(
        (
            chain["stages"][1]["state"].as_str(),
            chain["stages"][1]["fork_permitted"].as_bool()
        ),
        (Some("available"), Some(true))
    );
    h.finish().await;
}

#[tokio::test]
async fn revoking_twice_or_withdrawing_twice_is_safe_and_consistent() {
    let h = Harness::new().await;
    let (stage, manage_key, _) = setup(&h).await;
    let first = put_permission(&h, &stage, &manage_key, false).await;
    let second = put_permission(&h, &stage, &manage_key, false).await;
    assert_eq!(first, second);
    let w1 = withdraw(&h, &stage, &manage_key).await;
    let w2 = withdraw(&h, &stage, &manage_key).await;
    assert_eq!(w1, w2);
    assert_eq!(w2.1, json!({ "fork_permitted": false, "withdrawn": true }));
    h.finish().await;
}

#[tokio::test]
async fn a_withdrawal_never_weakens_a_hide_the_operator_made_for_rights() {
    let h = Harness::new().await;
    let (stage, manage_key, _) = setup(&h).await;
    sqlx::query("UPDATE publications SET hidden_reason = 'rights' WHERE id = $1")
        .bind(&stage)
        .execute(h.db.store.pool())
        .await
        .expect("hide");
    let (status, _) = withdraw(&h, &stage, &manage_key).await;
    assert_eq!(status, StatusCode::OK);
    let reason: String = sqlx::query_scalar("SELECT hidden_reason FROM publications WHERE id = $1")
        .bind(&stage)
        .fetch_one(h.db.store.pool())
        .await
        .expect("reason");
    assert_eq!(
        reason, "rights",
        "a maker cannot turn a rights hide into a withdrawal"
    );
    h.finish().await;
}

/// Holds a flip at `checked` until released (once armed), and says when it got there.
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
async fn a_revoke_waits_for_a_fork_in_flight_and_every_fork_after_it_is_refused() {
    let armed = Arc::new(AtomicBool::new(false));
    let reached = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (a, r, l) = (armed.clone(), reached.clone(), release.clone());
    let h = Harness::configured_with_gate(
        |_| {},
        move |_| {
            Arc::new(Hold {
                armed: a,
                reached: r,
                release: l,
            })
        },
    )
    .await;
    let (stage, manage_key, _) = setup(&h).await;

    // A fork of the stage reads its flags (still open) and is held just before it writes.
    armed.store(true, Ordering::SeqCst);
    let fork = {
        let client = h.client();
        let req = flip_body(&stage, 20_000, 2);
        tokio::spawn(async move { client.post("/v1/publications", &req).await })
    };
    tokio::time::timeout(Duration::from_secs(5), reached.notified())
        .await
        .expect("the fork reached the gate");

    // The revoke must wait for it: it needs the same lock the fork holds.
    let revoke = {
        let app = h.client();
        let (id, key_value) = (stage.clone(), manage_key.clone());
        tokio::spawn(async move {
            app.send(
                "PUT",
                &format!("/v1/publications/{id}/fork-permission"),
                &[(KEY, &key_value)],
                Some(&json!({ "permitted": false })),
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !revoke.is_finished(),
        "a revoke must not overtake a fork that already read the old flag"
    );
    assert!(!fork.is_finished());

    release.notify_one();
    let (fork_status, _, fork_body) = fork.await.expect("fork task");
    assert_eq!(
        fork_status,
        StatusCode::CREATED,
        "the fork that began first completes: {fork_body}"
    );
    let (revoke_status, _, state) = revoke.await.expect("revoke task");
    assert_eq!(
        (revoke_status, &state),
        (
            StatusCode::OK,
            &json!({ "fork_permitted": false, "withdrawn": false })
        )
    );

    // And everything after the revoke is refused.
    let (status, _, res) = h
        .post("/v1/publications", &flip_body(&stage, 10_000, 3))
        .await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::FORBIDDEN,
            Some("urn:graft:problem:fork-not-permitted")
        )
    );
    h.finish().await;
}
