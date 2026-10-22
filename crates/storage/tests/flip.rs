#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! `Store::create_flip` against a real Postgres: the rules that look across children, the
//! idempotent replay, and how concurrent forks of one stage behave.

use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::record::{ContentRecord, Cut, METHOD_HERMITE, RendererIdentity, Transform};
use graft_storage::blob::BoxFuture;
use graft_storage::gate::points;
use graft_storage::testing::TestDb;
use graft_storage::{FlipOutcome, Gate, NewFlip, NewPublication, Refusal};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

fn h(n: u8) -> Sha256Hash {
    Sha256Hash::from_bytes([n; 32])
}

fn renderer() -> RendererIdentity {
    RendererIdentity {
        name: "graft-render".into(),
        version: 1,
        wasm_sha256: h(0xcd),
    }
}

fn source(key: &str) -> NewPublication {
    NewPublication {
        id: PublicationId::seeded(key),
        record: ContentRecord::source(h(1), 48_000, renderer()).expect("valid"),
        retry_key: key.to_owned(),
        title: "door".into(),
        author: "pat".into(),
        evidence: None,
        manage_key_hash: None,
    }
}

fn flip(parent: &NewPublication, key: &str, cut_end: u32, out: u8, cap: u32) -> NewFlip {
    let record = ContentRecord::flip(
        parent.id.clone(),
        parent.record.output_blob(),
        Cut {
            start: 0,
            end: cut_end,
        },
        Transform {
            p: 3,
            q: 2,
            method: METHOD_HERMITE,
        },
        renderer(),
        h(out),
    )
    .expect("valid");
    NewFlip {
        publication: NewPublication {
            id: PublicationId::seeded(key),
            record,
            retry_key: key.to_owned(),
            title: "slower".into(),
            author: "jo".into(),
            evidence: None,
            manage_key_hash: Some([7; 32]),
        },
        max_forks_per_stage_per_hour: cap,
        serialization_retries: 8,
    }
}

async fn count(db: &TestDb, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
        .fetch_one(db.store.pool())
        .await
        .expect("count")
}

async fn with_parent() -> (TestDb, NewPublication) {
    let db = TestDb::create().await;
    let parent = source("seed:a");
    db.store.create_publication(&parent).await.expect("seed");
    (db, parent)
}

#[tokio::test]
async fn a_flip_is_created_with_only_the_hash_of_its_manage_key_stored() {
    let (db, parent) = with_parent().await;
    let f = flip(&parent, "k1", 24_000, 2, 10);
    let FlipOutcome::Created(stage) = db.store.create_flip(&f).await.expect("create") else {
        panic!("expected Created")
    };
    assert_eq!(stage.id, f.publication.id);
    let stored: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT manage_key_hash FROM publications WHERE id = $1")
            .bind(stage.id.as_str())
            .fetch_one(db.store.pool())
            .await
            .expect("row");
    assert_eq!(stored, Some(vec![7u8; 32]));
    db.drop_db().await;
}

#[tokio::test]
async fn a_replay_returns_the_original_even_after_forking_was_revoked_and_the_cap_filled() {
    let (db, parent) = with_parent().await;
    let f = flip(&parent, "k1", 24_000, 2, 1);
    assert!(matches!(
        db.store.create_flip(&f).await.expect("create"),
        FlipOutcome::Created(_)
    ));
    sqlx::query("UPDATE publications SET fork_permitted = false WHERE id = $1")
        .bind(parent.id.as_str())
        .execute(db.store.pool())
        .await
        .expect("revoke");
    let again = db.store.create_flip(&f).await.expect("replay");
    assert!(matches!(again, FlipOutcome::Existing(_)), "got {again:?}");
    assert_eq!(count(&db, "publications").await, 2);
    db.drop_db().await;
}

#[tokio::test]
async fn the_same_key_with_different_content_is_a_conflict_and_writes_nothing() {
    let (db, parent) = with_parent().await;
    db.store
        .create_flip(&flip(&parent, "k1", 24_000, 2, 10))
        .await
        .expect("create");
    let other = flip(&parent, "k1", 20_000, 3, 10);
    assert_eq!(
        db.store.create_flip(&other).await.expect("call"),
        FlipOutcome::KeyConflict
    );
    assert_eq!(
        (
            count(&db, "publications").await,
            count(&db, "content_records").await
        ),
        (2, 2)
    );
    db.drop_db().await;
}

#[tokio::test]
async fn a_missing_hidden_or_closed_parent_refuses_and_writes_nothing() {
    let (db, parent) = with_parent().await;
    let ghost = NewPublication {
        id: PublicationId::from_bits(99),
        ..source("seed:ghost")
    };
    let orphan = flip(&ghost, "k0", 24_000, 2, 10);
    // The record names a parent that was never created.
    assert_eq!(
        db.store.create_flip(&orphan).await.expect("call"),
        FlipOutcome::Refused(Refusal::ParentMissing)
    );

    sqlx::query("UPDATE publications SET fork_permitted = false WHERE id = $1")
        .bind(parent.id.as_str())
        .execute(db.store.pool())
        .await
        .expect("revoke");
    assert_eq!(
        db.store
            .create_flip(&flip(&parent, "k1", 24_000, 2, 10))
            .await
            .expect("call"),
        FlipOutcome::Refused(Refusal::ForkNotPermitted)
    );
    sqlx::query(
        "UPDATE publications SET fork_permitted = true, hidden_reason = 'rights' WHERE id = $1",
    )
    .bind(parent.id.as_str())
    .execute(db.store.pool())
    .await
    .expect("hide");
    assert_eq!(
        db.store
            .create_flip(&flip(&parent, "k2", 24_000, 2, 10))
            .await
            .expect("call"),
        FlipOutcome::Refused(Refusal::ParentHidden)
    );
    assert_eq!(
        (
            count(&db, "publications").await,
            count(&db, "content_records").await
        ),
        (1, 1)
    );
    db.drop_db().await;
}

#[tokio::test]
async fn the_fork_cap_refuses_beyond_the_limit_and_forgets_forks_older_than_an_hour() {
    let (db, parent) = with_parent().await;
    for (i, key) in ["k1", "k2"].iter().enumerate() {
        let out = u8::try_from(i).expect("small") + 2;
        assert!(matches!(
            db.store
                .create_flip(&flip(&parent, key, 24_000 + u32::from(out), out, 2))
                .await
                .expect("create"),
            FlipOutcome::Created(_)
        ));
    }
    let third = flip(&parent, "k3", 25_000, 9, 2);
    assert_eq!(
        db.store.create_flip(&third).await.expect("call"),
        FlipOutcome::Refused(Refusal::ForkCapReached { limit: 2 })
    );
    assert_eq!(
        count(&db, "publications").await,
        3,
        "nothing was written for the refused flip"
    );
    sqlx::query(
        "UPDATE publications SET created_at = now() - interval '2 hours' WHERE retry_key = 'k1'",
    )
    .execute(db.store.pool())
    .await
    .expect("age");
    assert!(
        matches!(
            db.store.create_flip(&third).await.expect("call"),
            FlipOutcome::Created(_)
        ),
        "a fork from two hours ago no longer counts"
    );
    db.drop_db().await;
}

/// Counts how often transactions reach each point, so a test can see how many attempts it took.
#[derive(Default)]
struct Counting(Mutex<HashMap<&'static str, u32>>);

impl Gate for Counting {
    fn reached(&self, point: &'static str) -> BoxFuture<'_, ()> {
        *self.0.lock().expect("lock").entry(point).or_default() += 1;
        Box::pin(async {})
    }
}

#[tokio::test]
async fn more_concurrent_forks_than_pool_connections_all_succeed_without_deadlock_or_conflicts() {
    // More forks than the pool has connections (16): a holder that needed a second connection
    // while the waiters held the rest would deadlock here.
    const N: usize = 48;
    let db = TestDb::create().await;
    let counting = Arc::new(Counting::default());
    let store = db.store.clone().with_gate(counting.clone());
    let parent = source("seed:a");
    store.create_publication(&parent).await.expect("seed");
    let tasks: Vec<_> = (0..N)
        .map(|i| {
            let store = store.clone();
            let f = flip(
                &parent,
                &format!("k{i}"),
                24_000 + u32::try_from(i).expect("small"),
                2 + u8::try_from(i).expect("small"),
                1000,
            );
            tokio::spawn(async move { store.create_flip(&f).await })
        })
        .collect();
    let mut created = 0;
    let all = async {
        for t in tasks {
            match t.await.expect("task").expect("no request may fail") {
                FlipOutcome::Created(_) => created += 1,
                other => panic!("unexpected {other:?}"),
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), all)
        .await
        .expect("forks of one stage must not deadlock over a small pool");
    assert_eq!(created, N);
    assert_eq!(
        count(&db, "publications").await,
        i64::try_from(N).expect("small") + 1
    );
    let attempts = counting
        .0
        .lock()
        .expect("lock")
        .get(points::LOCKED)
        .copied()
        .unwrap_or(0);
    eprintln!(
        "measured: {N} concurrent forks took {attempts} transaction attempts ({} retries)",
        attempts as usize - N
    );
    assert_eq!(
        attempts as usize, N,
        "the lock on the parent should make forks queue, not conflict"
    );
    db.drop_db().await;
}
