#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Seam 1, concurrency: forks and retries racing through the real router, a real Postgres and the
//! real renderer. These are the tests the README and ARCHITECTURE point at. Each test names the
//! guarantee it protects, and the two guarantees are kept apart:
//!
//! 1. Below the configured limits, every valid concurrent fork of one stage ends up published
//!    exactly once (through a same-key retry if the service says "busy").
//! 2. At or beyond the limits, each request is accepted up to the limit or refused with a stated
//!    reason; none disappears.

mod common;

use axum::http::StatusCode;
use common::{Harness, is_problem};
use graft_domain::ids::PublicationId;
use graft_storage::Gate;
use graft_storage::blob::BoxFuture;
use graft_storage::gate::points;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

fn key(tag: &str, n: u32) -> String {
    format!("race-{tag}-{n:05}-padding")
}

fn body(parent: &str, cut_end: u32, retry_key: &str) -> Value {
    json!({
        "parent_id": parent,
        "cut": { "start": 0, "end": cut_end },
        "speed": { "p": 1, "q": 1 },
        "title": "slower",
        "author": "jo",
        "retry_key": retry_key,
    })
}

async fn source(h: &Harness, name: &str) -> String {
    match h.seed(name, 0).await {
        graft_storage::Outcome::Created(s) | graft_storage::Outcome::Existing(s) => {
            s.id.to_string()
        }
        graft_storage::Outcome::KeyConflict => panic!("conflict"),
    }
}

#[tokio::test]
async fn many_more_simultaneous_forks_than_connections_all_publish_and_the_count_is_exact() {
    const N: u32 = 40; // the pool has 16 connections
    const ROUNDS: u32 = 4;
    let started = Instant::now();
    // Guarantee 1 is about forks below the limits, so the cap is set well above N.
    let h = Harness::configured(|c| c.max_forks_per_stage_per_hour = 1000).await;
    let mut retries_needed = 0;
    for round in 0..ROUNDS {
        let parent = source(&h, &format!("seed:round{round}")).await;
        let tasks: Vec<_> = (0..N)
            .map(|i| {
                let client = h.client();
                let req = body(&parent, 20_000 + i, &key(&format!("r{round}"), i));
                tokio::spawn(async move { client.post_retrying("/v1/publications", &req, 6).await })
            })
            .collect();
        let mut child = None;
        for t in tasks {
            let (status, res, attempts) = t.await.expect("task");
            assert_eq!(
                status,
                StatusCode::CREATED,
                "every valid fork must end up published: {res}"
            );
            retries_needed += attempts - 1;
            child = Some(res["publication"]["id"].as_str().expect("id").to_owned());
        }
        // Read it back: the stage was flipped exactly N times, none lost, none counted twice.
        let (_, _, chain) = h
            .get(&format!("/v1/chains/{}", child.expect("a child")))
            .await;
        assert_eq!(
            chain["stages"][0]["flipped_count"], N,
            "round {round}: {chain}"
        );
    }
    let total = i64::from(ROUNDS * (N + 1));
    assert_eq!(h.count("publications").await, total);
    eprintln!(
        "measured: {ROUNDS} rounds of {N} simultaneous forks over a 16-connection pool, {retries_needed} client retries, {:?}",
        started.elapsed()
    );
    assert!(started.elapsed() < Duration::from_secs(60));
    h.finish().await;
}

#[tokio::test]
async fn simultaneous_requests_with_the_same_key_and_payload_create_exactly_one_publication() {
    const M: u32 = 24;
    let h = Harness::new().await;
    let parent = source(&h, "seed:door").await;
    let req = body(&parent, 24_000, &key("same", 1));
    let tasks: Vec<_> = (0..M)
        .map(|_| {
            let client = h.client();
            let req = req.clone();
            tokio::spawn(async move { client.post_retrying("/v1/publications", &req, 6).await })
        })
        .collect();
    let mut created = 0;
    let mut replays = 0;
    let mut publications = Vec::new();
    let mut keys = 0;
    for t in tasks {
        let (status, res, _) = t.await.expect("task");
        match status {
            StatusCode::CREATED => created += 1,
            StatusCode::OK => replays += 1,
            other => panic!("unexpected {other}: {res}"),
        }
        if res["manage_key"].is_string() {
            keys += 1;
        }
        publications.push(res["publication"].clone());
    }
    assert_eq!(
        (created, replays),
        (1, M - 1),
        "exactly one creates, every other request is a replay"
    );
    assert_eq!(
        keys, 1,
        "the manage key is shown once, to the request that created it"
    );
    assert!(
        publications.iter().all(|p| p == &publications[0]),
        "every response names the same publication, identically"
    );
    assert_eq!(h.count("publications").await, 2, "the parent and one flip");
    h.finish().await;
}

#[tokio::test]
async fn simultaneous_requests_with_the_same_key_and_different_payloads_yield_one_success_and_conflicts()
 {
    const M: u32 = 24;
    let h = Harness::new().await;
    let parent = source(&h, "seed:door").await;
    let tasks: Vec<_> = (0..M)
        .map(|i| {
            let client = h.client();
            let req = body(&parent, 20_000 + i, &key("diff", 1));
            tokio::spawn(async move { client.post_retrying("/v1/publications", &req, 6).await })
        })
        .collect();
    let (mut created, mut conflicts) = (0, 0);
    for t in tasks {
        let (status, res, _) = t.await.expect("task");
        match status {
            StatusCode::CREATED => created += 1,
            StatusCode::CONFLICT => {
                assert_eq!(res["type"], "urn:graft:problem:key-conflict");
                conflicts += 1;
            }
            other => panic!("unexpected {other}: {res}"),
        }
    }
    assert_eq!((created, conflicts), (1, M - 1));
    assert_eq!(h.count("publications").await, 2);
    h.finish().await;
}

#[tokio::test]
async fn at_the_fork_cap_every_request_is_accepted_up_to_the_limit_or_refused_and_none_disappears()
{
    const SENT: u32 = 20;
    const CAP: u32 = 5;
    let h = Harness::configured(|c| c.max_forks_per_stage_per_hour = CAP).await;
    let parent = source(&h, "seed:door").await;
    let tasks: Vec<_> = (0..SENT)
        .map(|i| {
            let client = h.client();
            let req = body(&parent, 20_000 + i, &key("cap", i));
            tokio::spawn(async move { client.post_retrying("/v1/publications", &req, 6).await })
        })
        .collect();
    let (mut accepted, mut refused) = (0, 0);
    for t in tasks {
        let (status, res, _) = t.await.expect("task");
        match status {
            StatusCode::CREATED => accepted += 1,
            StatusCode::TOO_MANY_REQUESTS => {
                assert_eq!(res["type"], "urn:graft:problem:fork-cap");
                refused += 1;
            }
            other => panic!("unexpected {other}: {res}"),
        }
    }
    assert_eq!(
        accepted + refused,
        SENT,
        "accepted + refused must equal sent"
    );
    assert_eq!(
        accepted, CAP,
        "exactly the cap is accepted, never one more under a race"
    );
    assert_eq!(h.count("publications").await, i64::from(CAP) + 1);
    h.finish().await;
}

#[tokio::test]
async fn at_the_depth_cap_every_concurrent_request_is_refused_with_the_same_reason() {
    let limits = graft_domain::limits::Limits {
        max_chain_depth: 2,
        ..Default::default()
    };
    let h = Harness::with_limits(limits).await;
    let parent = source(&h, "seed:door").await;
    let (_, _, first) = h
        .post("/v1/publications", &body(&parent, 24_000, &key("d", 0)))
        .await;
    let child = first["publication"]["id"].as_str().expect("id").to_owned();
    let tasks: Vec<_> = (1..=12)
        .map(|i| {
            let client = h.client();
            let req = body(&child, 20_000 + i, &key("d", i));
            tokio::spawn(async move { client.post("/v1/publications", &req).await })
        })
        .collect();
    for t in tasks {
        let (status, _, res) = t.await.expect("task");
        assert_eq!(
            (status, res["type"].as_str()),
            (StatusCode::CONFLICT, Some("urn:graft:problem:depth-cap"))
        );
    }
    assert_eq!(
        h.count("publications").await,
        2,
        "nothing was written past the cap"
    );
    h.finish().await;
}

/// Runs a write that conflicts with a flip but takes no lock, while armed and at `CHECKED`.
struct Conflicts {
    pool: sqlx::PgPool,
    parent: Arc<std::sync::Mutex<Option<PublicationId>>>,
    armed: Arc<AtomicBool>,
    attempts: Arc<AtomicU32>,
}

impl Gate for Conflicts {
    fn reached(&self, point: &'static str) -> BoxFuture<'_, ()> {
        if point == points::LOCKED {
            self.attempts.fetch_add(1, Ordering::SeqCst);
        }
        let run = point == points::CHECKED && self.armed.load(Ordering::SeqCst);
        Box::pin(async move {
            if !run {
                return;
            }
            let parent = self
                .parent
                .lock()
                .expect("lock")
                .clone()
                .expect("parent known");
            let mut tx = self.pool.begin().await.expect("begin");
            sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                .execute(&mut *tx)
                .await
                .expect("level");
            sqlx::query("SELECT count(*) FROM content_records WHERE parent_publication_id = $1")
                .bind(parent.as_str())
                .fetch_one(&mut *tx)
                .await
                .expect("read children");
            sqlx::query("UPDATE publications SET fork_permitted = fork_permitted WHERE id = $1")
                .bind(parent.as_str())
                .execute(&mut *tx)
                .await
                .expect("write the parent");
            tx.commit().await.expect("commit");
        })
    }
}

#[tokio::test]
async fn when_conflicts_outlast_the_retries_the_answer_is_retry_later_and_the_same_request_then_succeeds_once()
 {
    let started = Instant::now();
    let armed = Arc::new(AtomicBool::new(true));
    let attempts = Arc::new(AtomicU32::new(0));
    let parent_slot = Arc::new(std::sync::Mutex::new(None));
    let (a, n, p) = (armed.clone(), attempts.clone(), parent_slot.clone());
    let h = Harness::configured_with_gate(
        |c| c.serialization_retries = 1,
        move |pool| {
            Arc::new(Conflicts {
                pool,
                parent: p,
                armed: a,
                attempts: n,
            })
        },
    )
    .await;
    let parent = source(&h, "seed:door").await;
    *parent_slot.lock().expect("lock") = Some(PublicationId::parse(&parent).expect("id"));
    let req = body(&parent, 24_000, &key("exhaust", 1));

    let (status, headers, res) = h.post("/v1/publications", &req).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{res}");
    assert!(is_problem(&headers));
    assert_eq!(res["type"], "urn:graft:problem:retry-later");
    assert_eq!(headers["retry-after"], "1");
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        2,
        "the first try and its one retry both conflicted"
    );
    assert_eq!(h.count("publications").await, 1, "nothing was written");

    armed.store(false, Ordering::SeqCst);
    let (status, _, created) = h.post("/v1/publications", &req).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let (status, _, replay) = h.post("/v1/publications", &req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["publication"], replay["publication"]);
    assert_eq!(
        h.count("publications").await,
        2,
        "exactly one publication for the key"
    );
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "took {:?}: a lock was not released on the error path",
        started.elapsed()
    );
    h.finish().await;
}

#[tokio::test]
async fn a_stage_that_stays_busy_answers_retry_later_quickly_and_recovers_when_freed() {
    let h = Harness::configured(|c| c.lock_wait_ms = 250).await;
    let parent = source(&h, "seed:door").await;
    let mut holder = h.db.store.pool().acquire().await.expect("connection");
    sqlx::query("SELECT pg_advisory_lock(hashtextextended($1, 0))")
        .bind(&parent)
        .execute(&mut *holder)
        .await
        .expect("lock");
    let req = body(&parent, 24_000, &key("busy", 1));
    let started = Instant::now();
    let (status, _, res) = h.post("/v1/publications", &req).await;
    assert_eq!(
        (status, res["type"].as_str()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Some("urn:graft:problem:retry-later")
        ),
        "{res}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "waited {:?}",
        started.elapsed()
    );
    sqlx::query("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
        .bind(&parent)
        .execute(&mut *holder)
        .await
        .expect("unlock");
    drop(holder);
    let (status, _, res) = h.post("/v1/publications", &req).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    h.finish().await;
}
