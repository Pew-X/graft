#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Forcing the interleavings that are rare in practice, against a real Postgres: a lock that stays
//! busy, a panic while the lock is held, a serialization failure on demand, and retry exhaustion.
//! The `Gate` holds a transaction at a named point while the test commits a conflicting write from
//! a separate connection that does not take the parent's lock.

use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::record::{ContentRecord, Cut, METHOD_HERMITE, RendererIdentity, Transform};
use graft_storage::blob::BoxFuture;
use graft_storage::gate::points;
use graft_storage::testing::TestDb;
use graft_storage::{FlipOutcome, Gate, NewFlip, NewPublication, StoreError};
use sqlx::PgPool;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

fn source() -> NewPublication {
    NewPublication {
        id: PublicationId::seeded("seed:a"),
        record: ContentRecord::source(h(1), 48_000, renderer()).expect("valid"),
        retry_key: "seed:a".into(),
        title: "door".into(),
        author: "pat".into(),
        evidence: None,
        manage_key_hash: None,
    }
}

fn flip(parent: &NewPublication, key: &str, retries: u32) -> NewFlip {
    NewFlip {
        publication: NewPublication {
            id: PublicationId::seeded(key),
            record: ContentRecord::flip(
                parent.id.clone(),
                parent.record.output_blob(),
                Cut {
                    start: 0,
                    end: 24_000,
                },
                Transform {
                    p: 3,
                    q: 2,
                    method: METHOD_HERMITE,
                },
                renderer(),
                h(2),
            )
            .expect("valid"),
            retry_key: key.to_owned(),
            title: "slower".into(),
            author: "jo".into(),
            evidence: None,
            manage_key_hash: Some([7; 32]),
        },
        max_forks_per_stage_per_hour: 1000,
        serialization_retries: retries,
        lock_wait: Duration::from_secs(10),
    }
}

async fn publications(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM publications")
        .fetch_one(pool)
        .await
        .expect("count")
}

/// Counts attempts and, while armed, runs `action` when a flip reaches `point`.
struct Hook {
    point: &'static str,
    attempts: AtomicU32,
    armed: Mutex<bool>,
    action: Box<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>,
}

impl Gate for Hook {
    fn reached(&self, point: &'static str) -> BoxFuture<'_, ()> {
        if point == points::LOCKED {
            self.attempts.fetch_add(1, Ordering::SeqCst);
        }
        let run = point == self.point && *self.armed.lock().expect("lock");
        Box::pin(async move {
            if run {
                (self.action)().await;
            }
        })
    }
}

/// A write that conflicts with a flip of `parent` under serializable isolation but takes no lock: it
/// reads the parent's children (as the flip's cap check does) and rewrites the parent's row (as a
/// concurrent revoke or hide would), then commits. Each of the two now has a read the other's write
/// invalidates, which is the cycle serializable isolation must break.
fn conflicting_write(pool: PgPool, parent: PublicationId) -> BoxFuture<'static, ()> {
    Box::pin(async move {
        let mut tx = pool.begin().await.expect("begin");
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
            .expect("write parent");
        tx.commit()
            .await
            .expect("the out-of-band write commits first");
    })
}

async fn with_hook(
    retries_for: impl FnOnce(
        &PgPool,
        &PublicationId,
    ) -> Box<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>,
    point: &'static str,
) -> (TestDb, graft_storage::Store, Arc<Hook>, NewPublication) {
    let db = TestDb::create().await;
    let parent = source();
    db.store.create_publication(&parent).await.expect("seed");
    let action = retries_for(db.store.pool(), &parent.id);
    let hook = Arc::new(Hook {
        point,
        attempts: AtomicU32::new(0),
        armed: Mutex::new(true),
        action,
    });
    let store = db.store.clone().with_gate(hook.clone());
    (db, store, hook, parent)
}

#[tokio::test]
async fn a_serialization_failure_is_retried_and_the_flip_then_succeeds_exactly_once() {
    let started = Instant::now();
    // Disarm after the first conflict: the first attempt is aborted, the second runs clean.
    let (db, store, hook, parent) = with_hook(
        |pool, parent| {
            let (pool, parent) = (pool.clone(), parent.clone());
            Box::new(move || conflicting_write(pool.clone(), parent.clone()))
        },
        points::CHECKED,
    )
    .await;
    let hook2 = hook.clone();
    let disarm = tokio::spawn(async move {
        while hook2.attempts.load(Ordering::SeqCst) < 1 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        *hook2.armed.lock().expect("lock") = false;
    });
    let outcome = store
        .create_flip(&flip(&parent, "k1", 5))
        .await
        .expect("the flip succeeds after retrying");
    disarm.await.expect("disarm");
    assert!(
        matches!(outcome, FlipOutcome::Created(_)),
        "got {outcome:?}"
    );
    assert!(
        hook.attempts.load(Ordering::SeqCst) > 1,
        "the conflict must really have happened and been retried"
    );
    assert_eq!(
        publications(db.store.pool()).await,
        2,
        "one parent, one flip: no duplicate"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}: the lock was not released on the error path",
        started.elapsed()
    );
    db.drop_db().await;
}

#[tokio::test]
async fn when_every_attempt_conflicts_the_error_is_retryable_and_the_same_key_then_succeeds_once() {
    let started = Instant::now();
    let (db, store, hook, parent) = with_hook(
        |pool, parent| {
            let (pool, parent) = (pool.clone(), parent.clone());
            Box::new(move || conflicting_write(pool.clone(), parent.clone()))
        },
        points::CHECKED,
    )
    .await;
    let request = flip(&parent, "k1", 2);
    let err = store
        .create_flip(&request)
        .await
        .expect_err("conflicts on every attempt exhaust the retries");
    assert_eq!(err, StoreError::RetryExhausted);
    assert_eq!(
        hook.attempts.load(Ordering::SeqCst),
        3,
        "the first try and two retries"
    );
    assert_eq!(
        publications(db.store.pool()).await,
        1,
        "nothing was written by the failed attempts"
    );

    // The conflicts stop; the client repeats the same request with the same key.
    *hook.armed.lock().expect("lock") = false;
    let outcome = store
        .create_flip(&request)
        .await
        .expect("the repeat succeeds");
    assert!(
        matches!(outcome, FlipOutcome::Created(_)),
        "got {outcome:?}"
    );
    let again = store
        .create_flip(&request)
        .await
        .expect("and a further repeat is a replay");
    assert!(matches!(again, FlipOutcome::Existing(_)));
    assert_eq!(
        publications(db.store.pool()).await,
        2,
        "exactly one publication for the key"
    );
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "took {:?}",
        started.elapsed()
    );
    db.drop_db().await;
}

#[tokio::test]
async fn a_stage_that_stays_busy_gives_busy_not_a_hang_and_works_again_when_freed() {
    let db = TestDb::create().await;
    let parent = source();
    db.store.create_publication(&parent).await.expect("seed");
    // Another session holds the stage's lock, as a slow concurrent fork would.
    let mut holder = db.store.pool().acquire().await.expect("connection");
    sqlx::query("SELECT pg_advisory_lock(hashtextextended($1, 0))")
        .bind(parent.id.as_str())
        .execute(&mut *holder)
        .await
        .expect("lock");
    let mut request = flip(&parent, "k1", 5);
    request.lock_wait = Duration::from_millis(250);
    let started = Instant::now();
    let err = db
        .store
        .create_flip(&request)
        .await
        .expect_err("must give up waiting");
    assert_eq!(err, StoreError::Busy);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "waited {:?}",
        started.elapsed()
    );
    assert_eq!(publications(db.store.pool()).await, 1);

    sqlx::query("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
        .bind(parent.id.as_str())
        .execute(&mut *holder)
        .await
        .expect("unlock");
    drop(holder);
    let outcome = db
        .store
        .create_flip(&request)
        .await
        .expect("works once the stage is free");
    assert!(matches!(outcome, FlipOutcome::Created(_)));
    db.drop_db().await;
}

/// A gate whose panic stands for any bug that kills the task while it holds the lock.
struct PanicOnce(Mutex<bool>);

impl Gate for PanicOnce {
    fn reached(&self, point: &'static str) -> BoxFuture<'_, ()> {
        let boom = point == points::CHECKED
            && std::mem::replace(&mut *self.0.lock().expect("lock"), false);
        Box::pin(async move {
            assert!(!boom, "a deliberate panic while the parent lock is held");
        })
    }
}

#[tokio::test]
async fn a_panic_while_the_lock_is_held_cannot_leave_the_stage_stuck_or_the_pool_damaged() {
    let started = Instant::now();
    let db = TestDb::create().await;
    let parent = source();
    db.store.create_publication(&parent).await.expect("seed");
    let store = db
        .store
        .clone()
        .with_gate(Arc::new(PanicOnce(Mutex::new(true))));
    let err = store
        .create_flip(&flip(&parent, "k1", 5))
        .await
        .expect_err("the task panicked");
    assert!(matches!(err, StoreError::Db(_)), "got {err:?}");
    // The stage is not stuck for the next fork, and nothing was written by the dead one.
    let outcome = store
        .create_flip(&flip(&parent, "k2", 5))
        .await
        .expect("the next fork proceeds");
    assert!(matches!(outcome, FlipOutcome::Created(_)));
    assert_eq!(publications(db.store.pool()).await, 2);
    // The connection that was holding the lock was closed, not returned with the lock still on it.
    let held: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' \
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    )
    .fetch_one(db.store.pool())
    .await
    .expect("locks");
    assert_eq!(
        held, 0,
        "no advisory lock may outlive the work that took it"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );
    db.drop_db().await;
}

#[tokio::test]
async fn a_flip_cannot_name_itself_or_a_later_publication_so_chains_cannot_loop() {
    let db = TestDb::create().await;
    let parent = source();
    db.store.create_publication(&parent).await.expect("seed");
    // The parent of this flip is the flip's own id: the parent row does not exist yet.
    let mut selfish = flip(&parent, "k1", 5);
    let own = selfish.publication.id.clone();
    selfish.publication.record = ContentRecord::flip(
        own,
        parent.record.output_blob(),
        Cut {
            start: 0,
            end: 24_000,
        },
        Transform {
            p: 3,
            q: 2,
            method: METHOD_HERMITE,
        },
        renderer(),
        h(2),
    )
    .expect("valid");
    let outcome = db
        .store
        .create_flip(&selfish)
        .await
        .expect("a refusal, not an error");
    assert_eq!(
        outcome,
        FlipOutcome::Refused(graft_storage::Refusal::ParentMissing)
    );
    assert_eq!(publications(db.store.pool()).await, 1);
    db.drop_db().await;
}
