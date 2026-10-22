#![allow(clippy::expect_used, clippy::panic)] // test helpers fail loudly
//! Orphan cleanup against a real Postgres, with an in-memory blob store whose clock the test moves.

use graft_domain::hash::Sha256Hash;
use graft_domain::ids::PublicationId;
use graft_domain::record::{ContentRecord, Cut, METHOD_HERMITE, RendererIdentity, Transform};
use graft_storage::blob::BoxFuture;
use graft_storage::gate::points;
use graft_storage::testing::TestDb;
use graft_storage::{
    BlobStore, FlipOutcome, Gate, MemoryBlobStore, NewFlip, NewPublication, remove_orphans,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;
use tokio::sync::Notify;

const T0: i64 = 1_800_000_000_000;
const GRACE: Duration = Duration::from_secs(3600);
const REFRESH: Duration = Duration::from_secs(600);

fn grace_ms() -> i64 {
    i64::try_from(GRACE.as_millis()).expect("small")
}

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

/// A blob store on a clock the test controls.
fn blobs(refresh: Duration) -> (Arc<MemoryBlobStore>, Arc<AtomicI64>) {
    let now = Arc::new(AtomicI64::new(T0));
    let clock = now.clone();
    (
        Arc::new(MemoryBlobStore::with_clock(
            Arc::new(move || clock.load(Ordering::SeqCst)),
            refresh,
        )),
        now,
    )
}

fn source_over(audio: Sha256Hash) -> NewPublication {
    NewPublication {
        id: PublicationId::seeded("seed:a"),
        record: ContentRecord::source(audio, 48_000, renderer()).expect("valid"),
        retry_key: "seed:a".into(),
        title: "door".into(),
        author: "pat".into(),
        evidence: None,
        manage_key_hash: None,
    }
}

fn flip_to(parent: &NewPublication, key: &str, output: Sha256Hash) -> NewFlip {
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
                output,
            )
            .expect("valid"),
            retry_key: key.to_owned(),
            title: "slower".into(),
            author: "jo".into(),
            evidence: None,
            manage_key_hash: Some([7; 32]),
        },
        max_forks_per_stage_per_hour: 1000,
        serialization_retries: 5,
        lock_wait: Duration::from_secs(10),
    }
}

#[tokio::test]
async fn a_blob_left_by_a_failed_publish_is_removed_after_the_grace_period_and_not_before() {
    let db = TestDb::create().await;
    let (blobs, now) = blobs(REFRESH);
    let orphan = blobs
        .put_if_absent(vec![1; 1000])
        .await
        .expect("write, then the publish fails");
    // One millisecond short of the grace period: untouched.
    let early = remove_orphans(&db.store, blobs.as_ref(), GRACE, T0 + grace_ms() - 1)
        .await
        .expect("run");
    assert_eq!((early.removed, early.kept_recent), (0, 1));
    assert!(blobs.get(&orphan).is_some());
    // At the grace period: removed.
    now.store(T0 + grace_ms(), Ordering::SeqCst);
    let later = remove_orphans(&db.store, blobs.as_ref(), GRACE, T0 + grace_ms())
        .await
        .expect("run");
    assert_eq!((later.removed, later.kept_recent), (1, 0));
    assert!(blobs.get(&orphan).is_none());
    db.drop_db().await;
}

#[tokio::test]
async fn a_blob_a_content_record_uses_survives_however_old_it_is() {
    let db = TestDb::create().await;
    let (blobs, _) = blobs(REFRESH);
    let audio = blobs
        .put_if_absent(vec![2; 500])
        .await
        .expect("source audio");
    let output = blobs
        .put_if_absent(vec![3; 500])
        .await
        .expect("flip output");
    let leftover = blobs.put_if_absent(vec![4; 500]).await.expect("leftover");
    let parent = source_over(audio);
    db.store.create_publication(&parent).await.expect("source");
    db.store
        .create_flip(&flip_to(&parent, "k1", output))
        .await
        .expect("flip");
    let much_later = T0 + 100 * grace_ms();
    let report = remove_orphans(&db.store, blobs.as_ref(), GRACE, much_later)
        .await
        .expect("run");
    assert_eq!(
        (report.removed, report.kept_referenced),
        (1, 2),
        "{report:?}"
    );
    assert!(
        blobs.get(&audio).is_some() && blobs.get(&output).is_some(),
        "referenced audio survives"
    );
    assert!(
        blobs.get(&leftover).is_none(),
        "the one nothing uses is gone"
    );
    db.drop_db().await;
}

#[tokio::test]
async fn running_it_again_changes_nothing_and_concurrent_runs_agree() {
    let db = TestDb::create().await;
    let (blobs, _) = blobs(REFRESH);
    let mut orphans = Vec::new();
    for n in 10..20u8 {
        orphans.push(blobs.put_if_absent(vec![n; 100]).await.expect("orphan"));
    }
    let kept = blobs.put_if_absent(vec![99; 100]).await.expect("used");
    db.store
        .create_publication(&source_over(kept))
        .await
        .expect("source");
    let later = T0 + 2 * grace_ms();
    let runs: Vec<_> = (0..4)
        .map(|_| {
            let (store, blobs) = (db.store.clone(), blobs.clone());
            tokio::spawn(async move { remove_orphans(&store, blobs.as_ref(), GRACE, later).await })
        })
        .collect();
    let mut removed = 0;
    for r in runs {
        removed += r.await.expect("task").expect("no run fails").removed;
    }
    assert_eq!(
        removed,
        orphans.len(),
        "each orphan is removed exactly once across the runs"
    );
    assert!(blobs.get(&kept).is_some());
    let again = remove_orphans(&db.store, blobs.as_ref(), GRACE, later)
        .await
        .expect("run");
    assert_eq!(
        (again.removed, again.examined),
        (0, 1),
        "nothing left to remove"
    );
    db.drop_db().await;
}

/// Holds a flip just before its transaction commits (once armed), and says when it got there.
struct HoldBeforeCommit {
    armed: AtomicBool,
    reached: Arc<Notify>,
    release: Arc<Notify>,
}

impl Gate for HoldBeforeCommit {
    fn reached(&self, point: &'static str) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if point == points::BEFORE_COMMIT && self.armed.swap(false, Ordering::SeqCst) {
                self.reached.notify_one();
                self.release.notified().await;
            }
        })
    }
}

/// The dangerous interleaving: an old leftover blob has the same bytes a new publish needs. The
/// publish writes (or refreshes) the blob, and is held just before its transaction commits, while
/// the cleanup runs. Returns whether the blob survived the cleanup, and whether the flip committed.
async fn interleave(refresh: Duration) -> (bool, bool) {
    let db = TestDb::create().await;
    let (blobs, now) = blobs(refresh);
    let (audio_bytes, output_bytes) = (vec![5u8; 800], vec![6u8; 800]);
    let audio = blobs
        .put_if_absent(audio_bytes)
        .await
        .expect("source audio");
    let parent = source_over(audio);
    db.store.create_publication(&parent).await.expect("source");

    // A failed publish long ago left this output behind: unreferenced, and now very old.
    let output = blobs
        .put_if_absent(output_bytes.clone())
        .await
        .expect("the leftover");
    now.store(T0 + 5 * grace_ms(), Ordering::SeqCst);

    // A new publish needs the same bytes: it writes them again (put_if_absent), then runs its
    // transaction, which the gate holds just before the commit.
    blobs
        .put_if_absent(output_bytes)
        .await
        .expect("the new publish writes its blob");
    let (reached, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let gate = Arc::new(HoldBeforeCommit {
        armed: AtomicBool::new(true),
        reached: reached.clone(),
        release: release.clone(),
    });
    let store = db.store.clone().with_gate(gate);
    let request = flip_to(&parent, "k1", output);
    let publish = tokio::spawn(async move { store.create_flip(&request).await });
    tokio::time::timeout(Duration::from_secs(5), reached.notified())
        .await
        .expect("the flip reached the gate");

    // The cleanup runs now: the new publish's rows are not committed, so nothing refers to the blob.
    let report = remove_orphans(&db.store, blobs.as_ref(), GRACE, T0 + 5 * grace_ms())
        .await
        .expect("run");
    let survived = blobs.get(&output).is_some();
    release.notify_one();
    let committed = matches!(
        publish.await.expect("task").expect("flip"),
        FlipOutcome::Created(_)
    );
    assert_eq!(report.examined, 2);
    db.drop_db().await;
    (survived, committed)
}

#[tokio::test]
async fn a_cleanup_during_a_publish_never_removes_the_blob_the_publish_is_about_to_commit() {
    // Normal behaviour: writing the blob again refreshed its old time, so the cleanup sees it as
    // recent and leaves it, even though no committed record refers to it yet.
    let (survived, committed) = interleave(REFRESH).await;
    assert!(
        survived,
        "the blob a committing transaction needs must survive"
    );
    assert!(committed);
}

#[tokio::test]
async fn without_the_refresh_the_same_interleaving_would_lose_the_blob() {
    // The hazard is real, not hypothetical: a store that never refreshes (a threshold of a century)
    // keeps the old time, the cleanup deletes the blob, and the flip then commits a record that
    // names audio that is gone. This is why `put_if_absent` refreshes.
    let (survived, committed) = interleave(Duration::from_secs(100 * 365 * 24 * 3600)).await;
    assert!(
        !survived,
        "with no refresh the blob is deleted under the publish"
    );
    assert!(
        committed,
        "and the flip still commits: that is the damage the refresh prevents"
    );
}
